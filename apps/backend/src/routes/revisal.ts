import { RevisalDeliveryChannel, RevisalDeliveryStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { HttpError } from '../lib/http-error.js';
import { logger } from '../lib/logger.js';
import { enqueueNotificationEvent } from '../lib/notification-queue.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions } from '../middleware/auth.js';
import { buildRevisalExport } from '../services/revisal-service.js';
import { parsePeriod } from '../utils/period.js';
import { buildSimplePdf } from '../utils/pdf.js';

const router = Router();

const listQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  status: z.nativeEnum(RevisalDeliveryStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const generateSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  deliveryReference: z.string().trim().min(3).max(80).optional(),
  reason: z.string().trim().min(3).max(500).optional(),
});

const markDeliveredSchema = z.object({
  channel: z.nativeEnum(RevisalDeliveryChannel),
  deliveredAt: z.string().datetime().optional(),
  receiptNumber: z.string().trim().min(2).max(120).optional(),
  reason: z.string().trim().min(3).max(500).optional(),
});

function defaultDeliveryReference(period: string): string {
  const compactPeriod = period.replace('-', '');
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `REV-${compactPeriod}-${suffix}`;
}

function parseListQuery(raw: unknown): z.infer<typeof listQuerySchema> {
  const source = raw as Record<string, unknown>;
  const normalized = {
    period: typeof source.period === 'string' ? source.period : undefined,
    status: typeof source.status === 'string' ? source.status : undefined,
    limit: source.limit,
  };

  const parsed = listQuerySchema.safeParse(normalized);
  if (!parsed.success) {
    throw HttpError.badRequest('Query invalid pentru listarea exporturilor Revisal.');
  }

  return parsed.data;
}

function channelLabel(channel: RevisalDeliveryChannel | null): string {
  if (!channel) {
    return '—';
  }

  switch (channel) {
    case RevisalDeliveryChannel.WEB_PORTAL:
      return 'Portal Revisal';
    case RevisalDeliveryChannel.EMAIL:
      return 'Email';
    case RevisalDeliveryChannel.SFTP:
      return 'SFTP';
    case RevisalDeliveryChannel.MANUAL_UPLOAD:
      return 'Upload manual';
    case RevisalDeliveryChannel.OTHER:
      return 'Alt canal';
    default:
      return channel;
  }
}

function statusLabel(status: RevisalDeliveryStatus): string {
  switch (status) {
    case RevisalDeliveryStatus.GENERATED:
      return 'Generat';
    case RevisalDeliveryStatus.DELIVERED:
      return 'Livrat';
    case RevisalDeliveryStatus.FAILED:
      return 'Eroare';
    default:
      return status;
  }
}

function toCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

router.get('/exports', requirePermissions(PERMISSIONS.PAYROLL_READ), async (req, res) => {
  const query = parseListQuery(req.query);
  if (query.period) {
    parsePeriod(query.period);
  }

  const deliveries = await prisma.revisalDelivery.findMany({
    where: {
      companyId: req.user!.companyId!,
      ...(query.period ? { period: query.period } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: query.limit,
    select: {
      id: true,
      period: true,
      deliveryReference: true,
      status: true,
      channel: true,
      deliveredAt: true,
      receiptNumber: true,
      employeeCount: true,
      xmlChecksum: true,
      validationPerformed: true,
      validationPassed: true,
      validationErrors: true,
      validationWarnings: true,
      createdAt: true,
      updatedAt: true,
      initiatedBy: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  res.json(deliveries);
});

router.get('/exports/pdf', requirePermissions(PERMISSIONS.PAYROLL_READ), async (req, res) => {
  const query = parseListQuery(req.query);
  if (query.period) {
    parsePeriod(query.period);
  }

  const companyId = req.user!.companyId!;
  const [company, deliveries] = await Promise.all([
    prisma.company.findUnique({
      where: {
        id: companyId,
      },
      select: {
        code: true,
        name: true,
      },
    }),
    prisma.revisalDelivery.findMany({
      where: {
        companyId,
        ...(query.period ? { period: query.period } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: query.limit,
      select: {
        period: true,
        deliveryReference: true,
        status: true,
        channel: true,
        deliveredAt: true,
        receiptNumber: true,
        employeeCount: true,
        xmlChecksum: true,
        validationPerformed: true,
        validationPassed: true,
        validationErrors: true,
        validationWarnings: true,
        createdAt: true,
      },
    }),
  ]);

  const generatedAt = new Date().toLocaleString('ro-RO');
  const deliveredCount = deliveries.filter((delivery) => delivery.status === RevisalDeliveryStatus.DELIVERED).length;
  const failedCount = deliveries.filter((delivery) => delivery.status === RevisalDeliveryStatus.FAILED).length;

  const lines: string[] = [
    'SEGA Accounting - Lista exporturi Revisal',
    `Companie: ${company?.name ?? req.user?.companyName ?? 'N/A'} (${company?.code ?? req.user?.companyCode ?? 'N/A'})`,
    `Generat la: ${generatedAt}`,
    `Exporturi: ${deliveries.length} | Livrate: ${deliveredCount} | Erori: ${failedCount}`,
    '',
    'Perioada | Referinta | Status | Canal | Angajati | Generat | Livrat | Recipisa | Validare',
    '--------------------------------------------------------------------------------------------------------------',
    ...deliveries.map((delivery) => {
      const warningCount = toCount(delivery.validationWarnings);
      const errorCount = toCount(delivery.validationErrors);
      const validationLabel = delivery.validationPerformed
        ? delivery.validationPassed
          ? 'XSD OK'
          : `XSD NOK (${errorCount})`
        : 'XSD N/A';

      const warningsLabel = warningCount > 0 ? `, Warn ${warningCount}` : '';

      return `${delivery.period} | ${delivery.deliveryReference} | ${statusLabel(delivery.status)} | ${channelLabel(
        delivery.channel,
      )} | ${delivery.employeeCount} | ${delivery.createdAt.toLocaleString('ro-RO')} | ${
        delivery.deliveredAt ? delivery.deliveredAt.toLocaleString('ro-RO') : '-'
      } | ${delivery.receiptNumber ?? '-'} | ${validationLabel}${warningsLabel}`;
    }),
  ];

  const pdf = buildSimplePdf(lines);
  const safeCompanyCode = (company?.code ?? req.user?.companyCode ?? 'companie')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="exporturi-revisal-${safeCompanyCode}.pdf"`);
  res.send(pdf);
});

router.get('/exports/:id', requirePermissions(PERMISSIONS.PAYROLL_READ), async (req, res) => {
  const delivery = await prisma.revisalDelivery.findFirst({
    where: {
      id: String(req.params.id),
      companyId: req.user!.companyId!,
    },
    select: {
      id: true,
      period: true,
      deliveryReference: true,
      status: true,
      channel: true,
      deliveredAt: true,
      receiptNumber: true,
      employeeCount: true,
      xmlChecksum: true,
      validationPerformed: true,
      validationPassed: true,
      validationErrors: true,
      validationWarnings: true,
      createdAt: true,
      updatedAt: true,
      initiatedBy: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  if (!delivery) {
    throw HttpError.notFound('Exportul Revisal nu există.');
  }

  res.json(delivery);
});

router.post('/exports', requirePermissions(PERMISSIONS.PAYROLL_GENERATE), async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru generarea exportului Revisal.' });
    return;
  }

  parsePeriod(parsed.data.period);
  const companyId = req.user!.companyId!;
  const deliveryReference = parsed.data.deliveryReference?.trim() ?? defaultDeliveryReference(parsed.data.period);

  const existing = await prisma.revisalDelivery.findFirst({
    where: {
      companyId,
      deliveryReference,
    },
    select: { id: true },
  });
  if (existing) {
    throw HttpError.conflict(`Există deja un export Revisal cu referința ${deliveryReference}.`);
  }

  const exportResult = await buildRevisalExport(companyId, parsed.data.period, deliveryReference);
  if (exportResult.blockingErrors.length > 0) {
    res.status(422).json({
      message: 'Exportul Revisal nu poate fi generat din cauza erorilor de validare.',
      errors: exportResult.blockingErrors,
      warnings: exportResult.warnings,
      xsdValidation: exportResult.xsdValidation,
    });
    return;
  }

  const created = await prisma.$transaction(async (tx) => {
    const delivery = await tx.revisalDelivery.create({
      data: {
        companyId,
        initiatedById: req.user!.id,
        period: parsed.data.period,
        deliveryReference,
        status: RevisalDeliveryStatus.GENERATED,
        xmlContent: exportResult.xml,
        xmlChecksum: exportResult.xmlChecksum,
        employeeCount: exportResult.employeeCount,
        validationPerformed: exportResult.xsdValidation.performed,
        validationPassed: exportResult.xsdValidation.valid,
        validationErrors: exportResult.xsdValidation.errors.length > 0 ? exportResult.xsdValidation.errors : undefined,
        validationWarnings: exportResult.warnings.length > 0 ? exportResult.warnings : undefined,
      },
      select: {
        id: true,
        period: true,
        deliveryReference: true,
        status: true,
        employeeCount: true,
        xmlChecksum: true,
        validationPerformed: true,
        validationPassed: true,
        validationWarnings: true,
        createdAt: true,
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'revisal_deliveries',
        recordId: delivery.id,
        action: 'CREATE',
        reason: parsed.data.reason,
        afterData: {
          period: delivery.period,
          deliveryReference: delivery.deliveryReference,
          status: delivery.status,
          employeeCount: delivery.employeeCount,
          validationPerformed: delivery.validationPerformed,
          validationPassed: delivery.validationPassed,
        },
      },
      tx,
    );

    return delivery;
  });

  res.status(201).json({
    ...created,
    warnings: exportResult.warnings,
  });
});

router.get('/exports/:id/xml', requirePermissions(PERMISSIONS.PAYROLL_READ), async (req, res) => {
  const delivery = await prisma.revisalDelivery.findFirst({
    where: {
      id: String(req.params.id),
      companyId: req.user!.companyId!,
    },
    select: {
      id: true,
      period: true,
      deliveryReference: true,
      xmlContent: true,
      xmlChecksum: true,
    },
  });

  if (!delivery) {
    throw HttpError.notFound('Exportul Revisal nu există.');
  }

  const safeReference = delivery.deliveryReference.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64) || delivery.id;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="revisal-${delivery.period}-${safeReference}.xml"`);
  res.setHeader('X-Content-SHA256', delivery.xmlChecksum);
  res.send(delivery.xmlContent);
});

router.post('/exports/:id/deliver', requirePermissions(PERMISSIONS.PAYROLL_GENERATE), async (req, res) => {
  const parsed = markDeliveredSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru confirmarea livrării Revisal.' });
    return;
  }

  if (parsed.data.channel === RevisalDeliveryChannel.WEB_PORTAL && !parsed.data.receiptNumber) {
    throw HttpError.badRequest('receiptNumber este obligatoriu pentru livrarea prin portalul Revisal.');
  }

  const deliveryId = String(req.params.id);
  const current = await prisma.revisalDelivery.findFirst({
    where: {
      id: deliveryId,
      companyId: req.user!.companyId!,
    },
    select: {
      id: true,
      status: true,
      channel: true,
      deliveredAt: true,
      receiptNumber: true,
    },
  });

  if (!current) {
    throw HttpError.notFound('Exportul Revisal nu există.');
  }

  if (current.status === RevisalDeliveryStatus.DELIVERED) {
    throw HttpError.conflict('Exportul Revisal este deja marcat ca livrat.');
  }

  const deliveredAt = parsed.data.deliveredAt ? new Date(parsed.data.deliveredAt) : new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const record = await tx.revisalDelivery.update({
      where: { id: current.id },
      data: {
        status: RevisalDeliveryStatus.DELIVERED,
        channel: parsed.data.channel,
        deliveredAt,
        receiptNumber: parsed.data.receiptNumber ?? null,
      },
      select: {
        id: true,
        period: true,
        deliveryReference: true,
        status: true,
        channel: true,
        deliveredAt: true,
        receiptNumber: true,
        employeeCount: true,
        xmlChecksum: true,
        validationPerformed: true,
        validationPassed: true,
        validationWarnings: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'revisal_deliveries',
        recordId: record.id,
        action: 'DELIVER',
        reason: parsed.data.reason,
        beforeData: {
          status: current.status,
          channel: current.channel,
          deliveredAt: current.deliveredAt,
          receiptNumber: current.receiptNumber,
        },
        afterData: {
          status: record.status,
          channel: record.channel,
          deliveredAt: record.deliveredAt,
          receiptNumber: record.receiptNumber,
        },
      },
      tx,
    );

    return record;
  });

  void enqueueNotificationEvent({
    type: 'REVISAL_DELIVERED',
    companyId: req.user!.companyId!,
    companyName: req.user!.companyName,
    triggeredByUserId: req.user!.id,
    payload: {
      deliveryId: updated.id,
      period: updated.period,
      deliveryReference: updated.deliveryReference,
      channel: updated.channel ?? 'N/A',
      receiptNumber: updated.receiptNumber,
      deliveredAt: (updated.deliveredAt ?? deliveredAt).toISOString(),
    },
  }).catch((error) => {
    logger.warn('notification_enqueue_failed', {
      eventType: 'REVISAL_DELIVERED',
      companyId: req.user!.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  res.json(updated);
});

export default router;
