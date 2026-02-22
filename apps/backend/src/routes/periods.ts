import { JournalEntryStatus, PeriodStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../lib/http-error.js';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from '../lib/audit.js';
import { requirePermissions } from '../middleware/auth.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { parsePeriod } from '../utils/period.js';

const router = Router();

const updateStatusSchema = z.object({
  notes: z.string().max(500).optional(),
  reason: z.string().optional(),
});

router.get('/', requirePermissions(PERMISSIONS.PERIODS_READ), async (req, res) => {
  const companyId = req.user!.companyId!;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;

  if (from) {
    parsePeriod(from);
  }

  if (to) {
    parsePeriod(to);
  }

  const periods = await prisma.accountingPeriod.findMany({
    where: {
      companyId,
      period: {
        gte: from,
        lte: to,
      },
    },
    include: {
      closedBy: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
    orderBy: [{ period: 'desc' }],
    take: 120,
  });

  res.json(periods);
});

router.post('/:period/close', requirePermissions(PERMISSIONS.PERIODS_MANAGE), async (req, res) => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru închiderea perioadei.' });
    return;
  }

  const period = String(req.params.period);
  parsePeriod(period);

  const companyId = req.user!.companyId!;
  const now = new Date();

  const record = await prisma.$transaction(async (tx) => {
    const draftEntriesCount = await tx.journalEntry.count({
      where: {
        companyId,
        period,
        status: JournalEntryStatus.DRAFT,
      },
    });
    if (draftEntriesCount > 0) {
      throw HttpError.conflict(
        `Perioada ${period} nu poate fi închisă deoarece există ${draftEntriesCount} note în status DRAFT.`,
      );
    }

    const upserted = await tx.accountingPeriod.upsert({
      where: {
        companyId_period: {
          companyId,
          period,
        },
      },
      update: {
        status: PeriodStatus.CLOSED,
        closedAt: now,
        closedById: req.user!.id,
        notes: parsed.data.notes,
      },
      create: {
        companyId,
        period,
        status: PeriodStatus.CLOSED,
        closedAt: now,
        closedById: req.user!.id,
        notes: parsed.data.notes,
      },
    });

    await tx.journalEntry.updateMany({
      where: {
        companyId,
        period,
        status: JournalEntryStatus.VALIDATED,
      },
      data: {
        status: JournalEntryStatus.CLOSED,
      },
    });

    return upserted;
  });

  await writeAudit(req, {
    tableName: 'accounting_periods',
    recordId: record.id,
    action: 'CLOSE_PERIOD',
    reason: parsed.data.reason,
    afterData: {
      period: record.period,
      status: record.status,
      closedAt: record.closedAt,
      notes: record.notes,
    },
  });

  res.json(record);
});

router.post('/:period/reopen', requirePermissions(PERMISSIONS.PERIODS_MANAGE), async (req, res) => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru redeschiderea perioadei.' });
    return;
  }

  const period = String(req.params.period);
  parsePeriod(period);

  const companyId = req.user!.companyId!;

  const record = await prisma.$transaction(async (tx) => {
    const upserted = await tx.accountingPeriod.upsert({
      where: {
        companyId_period: {
          companyId,
          period,
        },
      },
      update: {
        status: PeriodStatus.OPEN,
        closedAt: null,
        closedById: null,
        notes: parsed.data.notes,
      },
      create: {
        companyId,
        period,
        status: PeriodStatus.OPEN,
        notes: parsed.data.notes,
      },
    });

    await tx.journalEntry.updateMany({
      where: {
        companyId,
        period,
        status: JournalEntryStatus.CLOSED,
      },
      data: {
        status: JournalEntryStatus.VALIDATED,
      },
    });

    return upserted;
  });

  await writeAudit(req, {
    tableName: 'accounting_periods',
    recordId: record.id,
    action: 'REOPEN_PERIOD',
    reason: parsed.data.reason,
    afterData: {
      period: record.period,
      status: record.status,
      notes: record.notes,
    },
  });

  res.json(record);
});

export default router;
