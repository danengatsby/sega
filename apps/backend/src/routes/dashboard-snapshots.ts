import type { Prisma } from '@prisma/client';
import { InvoiceStatus, SupplierInvoiceStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { HttpError } from '../lib/http-error.js';
import { parseListQuery, setPaginationHeaders } from '../lib/list-query.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions } from '../middleware/auth.js';
import { parseDateInput } from '../services/reports/helpers.js';
import { getStatements } from '../services/reports/statements-service.js';
import { round2, toNumber } from '../utils/number.js';

const router = Router();

const createSnapshotSchema = z.object({
  key: z.string().trim().min(1).max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  reason: z.string().optional(),
});

const snapshotSortFields = ['createdAt', 'key'] as const;

function buildSnapshotOrderBy(
  sortField: (typeof snapshotSortFields)[number],
  sortDirection: Prisma.SortOrder,
): Prisma.DashboardSnapshotOrderByWithRelationInput[] {
  switch (sortField) {
    case 'key':
      return [{ key: sortDirection }, { createdAt: 'desc' }];
    case 'createdAt':
    default:
      return [{ createdAt: sortDirection }, { id: 'desc' }];
  }
}

async function computeReceivablesSnapshot(companyId: string): Promise<{
  openAmount: number;
  overdueAmount: number;
  openInvoicesCount: number;
  overdueInvoicesCount: number;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      status: {
        in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID],
      },
    },
    include: {
      payments: true,
    },
  });

  let openAmount = 0;
  let overdueAmount = 0;
  let openInvoicesCount = 0;
  let overdueInvoicesCount = 0;

  for (const invoice of invoices) {
    const paid = round2(invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
    const open = round2(Math.max(toNumber(invoice.total) - paid, 0));

    if (open <= 0) {
      continue;
    }

    openInvoicesCount += 1;
    openAmount = round2(openAmount + open);

    if (invoice.dueDate < today) {
      overdueInvoicesCount += 1;
      overdueAmount = round2(overdueAmount + open);
    }
  }

  return {
    openAmount,
    overdueAmount,
    openInvoicesCount,
    overdueInvoicesCount,
  };
}

async function computePayablesSnapshot(companyId: string): Promise<{
  openAmount: number;
  overdueAmount: number;
  openInvoicesCount: number;
  overdueInvoicesCount: number;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const invoices = await prisma.supplierInvoice.findMany({
    where: {
      companyId,
      status: {
        in: [SupplierInvoiceStatus.RECEIVED, SupplierInvoiceStatus.PARTIALLY_PAID],
      },
    },
    include: {
      payments: true,
    },
  });

  let openAmount = 0;
  let overdueAmount = 0;
  let openInvoicesCount = 0;
  let overdueInvoicesCount = 0;

  for (const invoice of invoices) {
    const paid = round2(invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
    const open = round2(Math.max(toNumber(invoice.total) - paid, 0));

    if (open <= 0) {
      continue;
    }

    openInvoicesCount += 1;
    openAmount = round2(openAmount + open);

    if (invoice.dueDate < today) {
      overdueInvoicesCount += 1;
      overdueAmount = round2(overdueAmount + open);
    }
  }

  return {
    openAmount,
    overdueAmount,
    openInvoicesCount,
    overdueInvoicesCount,
  };
}

router.post('/', requirePermissions(PERMISSIONS.DASHBOARD_SNAPSHOTS_WRITE), async (req, res) => {
  const parsed = createSnapshotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru snapshot dashboard.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const from = parseDateInput(parsed.data.from, 'from');
  const to = parseDateInput(parsed.data.to, 'to');

  if (from && to && from.getTime() > to.getTime()) {
    throw HttpError.badRequest('Intervalul este invalid: from nu poate fi după to.');
  }

  const [bundle, receivables, payables, entityCounts] = await Promise.all([
    getStatements(companyId, { from, to }),
    computeReceivablesSnapshot(companyId),
    computePayablesSnapshot(companyId),
    Promise.all([
      prisma.account.count({ where: { companyId } }),
      prisma.partner.count({ where: { companyId } }),
      prisma.invoice.count({ where: { companyId } }),
      prisma.supplierInvoice.count({ where: { companyId } }),
      prisma.journalEntry.count({ where: { companyId } }),
      prisma.employee.count({ where: { companyId } }),
      prisma.asset.count({ where: { companyId } }),
    ]),
  ]);

  const snapshotPayload = {
    generatedAt: new Date().toISOString(),
    range: {
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
    },
    financial: {
      trialBalanceTotals: bundle.trialBalance.totals,
      pnl: bundle.pnl,
      balanceSheet: bundle.balanceSheet,
      taxSummary: bundle.taxSummary,
      agingReceivables: bundle.aging,
    },
    receivables,
    payables,
    entityCounts: {
      accounts: entityCounts[0],
      partners: entityCounts[1],
      invoices: entityCounts[2],
      supplierInvoices: entityCounts[3],
      journalEntries: entityCounts[4],
      employees: entityCounts[5],
      assets: entityCounts[6],
    },
  } as unknown as Prisma.InputJsonObject;

  const snapshot = await prisma.$transaction(async (tx) => {
    const created = await tx.dashboardSnapshot.create({
      data: {
        companyId,
        createdById: req.user!.id,
        key: parsed.data.key,
        from,
        to,
        payload: snapshotPayload,
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'dashboard_snapshots',
        recordId: created.id,
        action: 'CREATE',
        reason: parsed.data.reason,
        afterData: {
          key: created.key,
          from: created.from,
          to: created.to,
        },
      },
      tx,
    );

    return created;
  });

  res.status(201).json(snapshot);
});

router.get('/', requirePermissions(PERMISSIONS.DASHBOARD_SNAPSHOTS_READ), async (req, res) => {
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: snapshotSortFields,
    defaultSortField: 'createdAt',
    defaultSortDirection: 'desc',
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  const companyId = req.user!.companyId!;

  const where: Prisma.DashboardSnapshotWhereInput = query.search
    ? {
        companyId,
        key: { contains: query.search, mode: 'insensitive' },
      }
    : { companyId };

  const orderBy = buildSnapshotOrderBy(query.sortField, query.sortDirection);

  const [snapshots, totalCount] = await Promise.all([
    prisma.dashboardSnapshot.findMany({
      where,
      orderBy,
      skip: query.skip,
      take: query.take,
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    }),
    prisma.dashboardSnapshot.count({ where }),
  ]);

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(snapshots);
});

router.get('/latest', requirePermissions(PERMISSIONS.DASHBOARD_SNAPSHOTS_READ), async (req, res) => {
  const key = typeof req.query.key === 'string' && req.query.key.trim().length > 0 ? req.query.key.trim() : undefined;

  const snapshot = await prisma.dashboardSnapshot.findFirst({
    where: {
      companyId: req.user!.companyId!,
      ...(key ? { key } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    include: {
      createdBy: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  if (!snapshot) {
    throw HttpError.notFound('Nu există snapshot-uri dashboard pentru criteriul selectat.');
  }

  res.json(snapshot);
});

router.get('/:id', requirePermissions(PERMISSIONS.DASHBOARD_SNAPSHOTS_READ), async (req, res) => {
  const snapshot = await prisma.dashboardSnapshot.findFirst({
    where: {
      id: String(req.params.id),
      companyId: req.user!.companyId!,
    },
    include: {
      createdBy: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  if (!snapshot) {
    throw HttpError.notFound('Snapshot-ul dashboard nu există.');
  }

  res.json(snapshot);
});

export default router;
