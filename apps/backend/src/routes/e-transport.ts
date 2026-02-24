import { ETransportShipmentStatus, type Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { canTransitionETransportStatus, generateUitCode } from '../lib/e-transport.js';
import { parseListQuery, setPaginationHeaders } from '../lib/list-query.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions } from '../middleware/auth.js';

const router = Router();
const MAX_UIT_GENERATION_ATTEMPTS = 12;
const statusValues = Object.values(ETransportShipmentStatus);
const sortFields = ['createdAt', 'updatedAt', 'uit', 'status', 'vehicleNumber', 'plannedDepartureAt'] as const;
type SortField = (typeof sortFields)[number];

const createShipmentSchema = z.object({
  shipmentReference: z.string().min(3).max(64).optional(),
  vehicleNumber: z.string().min(2).max(32),
  carrierName: z.string().min(2).max(160).optional(),
  originLocation: z.string().min(2).max(200),
  destinationLocation: z.string().min(2).max(200),
  goodsDescription: z.string().min(3).max(500),
  goodsCategory: z.string().max(120).optional(),
  quantity: z.coerce.number().positive().max(999_999_999).optional(),
  unit: z.string().max(24).optional(),
  grossWeightKg: z.coerce.number().positive().max(999_999_999).optional(),
  plannedDepartureAt: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(256).optional(),
});

const updateShipmentStatusSchema = z.object({
  status: z.nativeEnum(ETransportShipmentStatus),
  statusReason: z.string().max(300).optional(),
  actualDepartureAt: z.coerce.date().optional(),
  actualArrivalAt: z.coerce.date().optional(),
  reason: z.string().max(256).optional(),
});

function isPrismaKnownError(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string' &&
      (error as { code: string }).code === code,
  );
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function buildOrderBy(sortField: SortField, sortDirection: Prisma.SortOrder): Prisma.ETransportShipmentOrderByWithRelationInput[] {
  switch (sortField) {
    case 'updatedAt':
      return [{ updatedAt: sortDirection }, { createdAt: 'desc' }];
    case 'uit':
      return [{ uit: sortDirection }];
    case 'status':
      return [{ status: sortDirection }, { updatedAt: 'desc' }];
    case 'vehicleNumber':
      return [{ vehicleNumber: sortDirection }, { createdAt: 'desc' }];
    case 'plannedDepartureAt':
      return [{ plannedDepartureAt: sortDirection }, { createdAt: 'desc' }];
    case 'createdAt':
    default:
      return [{ createdAt: sortDirection }];
  }
}

async function reserveUniqueUitCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_UIT_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = generateUitCode();
    const existing = await prisma.eTransportShipment.findUnique({
      where: {
        uit: candidate,
      },
      select: {
        id: true,
      },
    });
    if (!existing) {
      return candidate;
    }
  }

  throw new Error('E_TRANSPORT_UIT_GENERATION_FAILED');
}

router.get('/shipments', requirePermissions(PERMISSIONS.E_TRANSPORT_READ), async (req, res) => {
  const listQuery = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: sortFields,
    defaultSortField: 'createdAt',
    defaultSortDirection: 'desc',
    defaultPageSize: 50,
    maxPageSize: 200,
    defaultPaginationEnabled: true,
  });

  const companyId = req.user!.companyId!;
  const rawStatus = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : '';
  if (rawStatus && !statusValues.includes(rawStatus as ETransportShipmentStatus)) {
    res.status(400).json({ message: 'Filtrul status este invalid.' });
    return;
  }

  const statusFilter = rawStatus ? (rawStatus as ETransportShipmentStatus) : null;
  const baseWhere: Prisma.ETransportShipmentWhereInput = {
    companyId,
    ...(statusFilter ? { status: statusFilter } : {}),
  };

  const where: Prisma.ETransportShipmentWhereInput = listQuery.search
    ? {
        AND: [
          baseWhere,
          {
            OR: [
              { uit: { contains: listQuery.search, mode: 'insensitive' } },
              { shipmentReference: { contains: listQuery.search, mode: 'insensitive' } },
              { vehicleNumber: { contains: listQuery.search, mode: 'insensitive' } },
              { carrierName: { contains: listQuery.search, mode: 'insensitive' } },
              { originLocation: { contains: listQuery.search, mode: 'insensitive' } },
              { destinationLocation: { contains: listQuery.search, mode: 'insensitive' } },
              { goodsDescription: { contains: listQuery.search, mode: 'insensitive' } },
              { goodsCategory: { contains: listQuery.search, mode: 'insensitive' } },
            ],
          },
        ],
      }
    : baseWhere;

  const shipmentsPromise = prisma.eTransportShipment.findMany({
    where,
    orderBy: buildOrderBy(listQuery.sortField, listQuery.sortDirection),
    skip: listQuery.skip,
    take: listQuery.take,
  });

  const [shipments, totalCount] = listQuery.paginationEnabled
    ? await Promise.all([shipmentsPromise, prisma.eTransportShipment.count({ where })])
    : [await shipmentsPromise, 0];

  if (listQuery.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: listQuery.page,
      pageSize: listQuery.pageSize,
    });
  }

  res.json(shipments);
});

router.get('/shipments/monitor', requirePermissions(PERMISSIONS.E_TRANSPORT_READ), async (req, res) => {
  const companyId = req.user!.companyId!;

  const [generated, inTransit, delivered, cancelled, activeShipments] = await Promise.all([
    prisma.eTransportShipment.count({ where: { companyId, status: ETransportShipmentStatus.GENERATED } }),
    prisma.eTransportShipment.count({ where: { companyId, status: ETransportShipmentStatus.IN_TRANSIT } }),
    prisma.eTransportShipment.count({ where: { companyId, status: ETransportShipmentStatus.DELIVERED } }),
    prisma.eTransportShipment.count({ where: { companyId, status: ETransportShipmentStatus.CANCELLED } }),
    prisma.eTransportShipment.findMany({
      where: {
        companyId,
        status: {
          in: [ETransportShipmentStatus.GENERATED, ETransportShipmentStatus.IN_TRANSIT],
        },
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 25,
    }),
  ]);

  res.json({
    generatedAt: new Date().toISOString(),
    companyId,
    counters: {
      [ETransportShipmentStatus.GENERATED]: generated,
      [ETransportShipmentStatus.IN_TRANSIT]: inTransit,
      [ETransportShipmentStatus.DELIVERED]: delivered,
      [ETransportShipmentStatus.CANCELLED]: cancelled,
    },
    activeShipments,
  });
});

router.get('/shipments/:id', requirePermissions(PERMISSIONS.E_TRANSPORT_READ), async (req, res) => {
  const shipment = await prisma.eTransportShipment.findFirst({
    where: {
      id: String(req.params.id),
      companyId: req.user!.companyId!,
    },
  });

  if (!shipment) {
    res.status(404).json({ message: 'Transportul nu există.' });
    return;
  }

  res.json(shipment);
});

router.post('/shipments', requirePermissions(PERMISSIONS.E_TRANSPORT_WRITE), async (req, res, next) => {
  const parsed = createShipmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru generarea UIT.' });
    return;
  }

  try {
    const shipment = await prisma.$transaction(async (tx) => {
      const uit = await reserveUniqueUitCode();
      const created = await tx.eTransportShipment.create({
        data: {
          companyId: req.user!.companyId!,
          createdById: req.user!.id,
          uit,
          shipmentReference: normalizeOptionalString(parsed.data.shipmentReference),
          vehicleNumber: parsed.data.vehicleNumber.trim().toUpperCase(),
          carrierName: normalizeOptionalString(parsed.data.carrierName),
          originLocation: parsed.data.originLocation.trim(),
          destinationLocation: parsed.data.destinationLocation.trim(),
          goodsDescription: parsed.data.goodsDescription.trim(),
          goodsCategory: normalizeOptionalString(parsed.data.goodsCategory),
          quantity: parsed.data.quantity,
          unit: normalizeOptionalString(parsed.data.unit),
          grossWeightKg: parsed.data.grossWeightKg,
          plannedDepartureAt: parsed.data.plannedDepartureAt,
          metadata: toJson(parsed.data.metadata),
          status: ETransportShipmentStatus.GENERATED,
        },
      });

      await writeAudit(
        req,
        {
          tableName: 'ETransportShipment',
          recordId: created.id,
          action: 'E_TRANSPORT_CREATE',
          reason: parsed.data.reason ?? 'generate-uit',
          companyId: created.companyId,
          beforeData: { exists: false },
          afterData: created,
        },
        tx,
      );

      return created;
    });

    res.status(201).json(shipment);
  } catch (error) {
    if (error instanceof Error && error.message === 'E_TRANSPORT_UIT_GENERATION_FAILED') {
      res.status(503).json({ message: 'Generarea codului UIT a eșuat. Încearcă din nou.' });
      return;
    }
    if (isPrismaKnownError(error, 'P2002')) {
      res.status(409).json({ message: 'Codul UIT este deja alocat. Reîncearcă cererea.' });
      return;
    }
    next(error);
  }
});

router.patch('/shipments/:id/status', requirePermissions(PERMISSIONS.E_TRANSPORT_WRITE), async (req, res) => {
  const parsed = updateShipmentStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru actualizarea statusului transportului.' });
    return;
  }

  const shipmentId = String(req.params.id);
  const shipment = await prisma.eTransportShipment.findFirst({
    where: {
      id: shipmentId,
      companyId: req.user!.companyId!,
    },
  });

  if (!shipment) {
    res.status(404).json({ message: 'Transportul nu există.' });
    return;
  }

  if (!canTransitionETransportStatus(shipment.status, parsed.data.status)) {
    res.status(409).json({
      message: `Tranziție invalidă de status (${shipment.status} -> ${parsed.data.status}).`,
    });
    return;
  }

  const defaultDepartureAt =
    parsed.data.status === ETransportShipmentStatus.IN_TRANSIT && !parsed.data.actualDepartureAt ? new Date() : undefined;
  const defaultArrivalAt =
    parsed.data.status === ETransportShipmentStatus.DELIVERED && !parsed.data.actualArrivalAt ? new Date() : undefined;

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.eTransportShipment.update({
      where: {
        id: shipment.id,
      },
      data: {
        status: parsed.data.status,
        statusReason: normalizeOptionalString(parsed.data.statusReason),
        actualDepartureAt: parsed.data.actualDepartureAt ?? defaultDepartureAt,
        actualArrivalAt: parsed.data.actualArrivalAt ?? defaultArrivalAt,
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'ETransportShipment',
        recordId: saved.id,
        action: 'E_TRANSPORT_STATUS_UPDATE',
        reason: parsed.data.reason ?? 'update-transport-status',
        companyId: saved.companyId,
        beforeData: shipment,
        afterData: saved,
      },
      tx,
    );

    return saved;
  });

  res.json(updated);
});

export default router;
