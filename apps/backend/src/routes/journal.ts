import { JournalEntryStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { invalidateFinancialStatementsCache } from '../lib/financial-statements-cache.js';
import { HttpError } from '../lib/http-error.js';
import { nextJournalEntryNumber } from '../lib/journal-entry-number.js';
import { assertPeriodOpen } from '../lib/period-lock.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions } from '../middleware/auth.js';
import { currentPeriod, validateDoubleEntry } from '../utils/accounting.js';
import { writeAudit } from '../lib/audit.js';

const router = Router();

const lineSchema = z.object({
  accountId: z.string().min(1),
  debit: z.coerce.number().min(0),
  credit: z.coerce.number().min(0),
  explanation: z.string().optional(),
});

const createSchema = z.object({
  date: z.string().datetime().optional(),
  description: z.string().min(3),
  period: z.string().optional(),
  sourceModule: z.string().optional(),
  lines: z.array(lineSchema).min(2),
  reason: z.string().optional(),
});

const validateEntrySchema = z.object({
  reason: z.string().optional(),
});

const stornoEntrySchema = z.object({
  date: z.string().datetime().optional(),
  period: z.string().optional(),
  description: z.string().min(3).optional(),
  reason: z.string().optional(),
});

router.get('/', requirePermissions(PERMISSIONS.JOURNAL_READ), async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;

  const entries = await prisma.journalEntry.findMany({
    where: {
      companyId: req.user!.companyId!,
      date: {
        gte: from,
        lte: to,
      },
    },
    include: {
      lines: {
        include: {
          account: true,
        },
      },
      reversalOf: {
        select: {
          id: true,
          number: true,
          status: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });

  res.json(entries);
});

router.post('/', requirePermissions(PERMISSIONS.JOURNAL_WRITE), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru notă contabilă.' });
    return;
  }

  validateDoubleEntry(parsed.data.lines);

  const accountIds = [...new Set(parsed.data.lines.map((line) => line.accountId))];
  const accounts = await prisma.account.findMany({
    where: {
      companyId: req.user!.companyId!,
      id: { in: accountIds },
      isActive: true,
    },
  });
  if (accounts.length !== accountIds.length) {
    res.status(400).json({ message: 'Unul sau mai multe conturi sunt invalide/inactive.' });
    return;
  }

  const entryDate = parsed.data.date ? new Date(parsed.data.date) : new Date();
  const entryPeriod = parsed.data.period ?? currentPeriod(entryDate);
  await assertPeriodOpen(req.user!.companyId!, entryPeriod);

  const entry = await prisma.$transaction(async (tx) => {
    const number = await nextJournalEntryNumber(tx, req.user!.companyId!, entryDate);
    return tx.journalEntry.create({
      data: {
        companyId: req.user!.companyId!,
        number,
        date: entryDate,
        description: parsed.data.description,
        period: entryPeriod,
        status: JournalEntryStatus.DRAFT,
        posted: false,
        sourceModule: parsed.data.sourceModule,
        createdById: req.user!.id,
        lines: {
          create: parsed.data.lines.map((line) => ({
            accountId: line.accountId,
            debit: line.debit,
            credit: line.credit,
            explanation: line.explanation,
          })),
        },
      },
      include: {
        lines: {
          include: {
            account: true,
          },
        },
      },
    });
  });

  await writeAudit(req, {
    tableName: 'journal_entries',
    recordId: entry.id,
    action: 'CREATE',
    reason: parsed.data.reason,
    afterData: {
      id: entry.id,
      number: entry.number,
      status: entry.status,
      description: entry.description,
      date: entry.date.toISOString(),
      lines: entry.lines,
    },
  });

  invalidateFinancialStatementsCache();

  res.status(201).json(entry);
});

router.post('/:id/validate', requirePermissions(PERMISSIONS.JOURNAL_WRITE), async (req, res) => {
  const parsed = validateEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru validarea notei contabile.' });
    return;
  }

  const entryId = String(req.params.id);
  const validated = await prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.findFirst({
      where: {
        id: entryId,
        companyId: req.user!.companyId!,
      },
      include: {
        lines: {
          include: {
            account: true,
          },
        },
      },
    });

    if (!entry) {
      throw HttpError.notFound('Nota contabilă nu a fost găsită.');
    }

    if (entry.status !== JournalEntryStatus.DRAFT) {
      throw HttpError.conflict('Doar notele în status DRAFT pot fi validate.');
    }

    validateDoubleEntry(
      entry.lines.map((line) => ({
        debit: Number(line.debit),
        credit: Number(line.credit),
      })),
    );

    await assertPeriodOpen(req.user!.companyId!, entry.period, tx);

    return tx.journalEntry.update({
      where: { id: entry.id },
      data: {
        status: JournalEntryStatus.VALIDATED,
        posted: true,
      },
      include: {
        lines: {
          include: {
            account: true,
          },
        },
      },
    });
  });

  await writeAudit(req, {
    tableName: 'journal_entries',
    recordId: validated.id,
    action: 'VALIDATE',
    reason: parsed.data.reason,
    afterData: {
      id: validated.id,
      number: validated.number,
      status: validated.status,
    },
  });

  invalidateFinancialStatementsCache();
  res.json(validated);
});

router.post('/:id/storno', requirePermissions(PERMISSIONS.JOURNAL_WRITE), async (req, res) => {
  const parsed = stornoEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru storno.' });
    return;
  }

  const sourceEntryId = String(req.params.id);
  const stornoDate = parsed.data.date ? new Date(parsed.data.date) : new Date();
  const stornoPeriod = parsed.data.period ?? currentPeriod(stornoDate);

  const stornoEntry = await prisma.$transaction(async (tx) => {
    const sourceEntry = await tx.journalEntry.findFirst({
      where: {
        id: sourceEntryId,
        companyId: req.user!.companyId!,
      },
      include: {
        lines: {
          include: {
            account: true,
          },
        },
      },
    });

    if (!sourceEntry) {
      throw HttpError.notFound('Nota contabilă sursă nu a fost găsită.');
    }

    if (sourceEntry.status === JournalEntryStatus.DRAFT) {
      throw HttpError.conflict('Storno este permis doar pentru note validate/închise.');
    }

    if (sourceEntry.reversalOfEntryId) {
      throw HttpError.conflict('Nu poți genera storno peste o notă care este deja storno.');
    }

    const existingStorno = await tx.journalEntry.findFirst({
      where: {
        companyId: req.user!.companyId!,
        reversalOfEntryId: sourceEntry.id,
      },
      select: {
        id: true,
      },
    });
    if (existingStorno) {
      throw HttpError.conflict('Există deja o notă storno asociată acestei note contabile.');
    }

    await assertPeriodOpen(req.user!.companyId!, stornoPeriod, tx);

    const number = await nextJournalEntryNumber(tx, req.user!.companyId!, stornoDate);
    return tx.journalEntry.create({
      data: {
        companyId: req.user!.companyId!,
        number,
        date: stornoDate,
        description:
          parsed.data.description ?? `Storno ${sourceEntry.number ?? sourceEntry.id}`,
        period: stornoPeriod,
        status: JournalEntryStatus.VALIDATED,
        posted: true,
        sourceModule: 'GENERAL_LEDGER_STORNO',
        createdById: req.user!.id,
        reversalOfEntryId: sourceEntry.id,
        lines: {
          create: sourceEntry.lines.map((line) => ({
            accountId: line.accountId,
            debit: Number(line.credit),
            credit: Number(line.debit),
            explanation: line.explanation ?? undefined,
          })),
        },
      },
      include: {
        lines: {
          include: {
            account: true,
          },
        },
        reversalOf: {
          select: {
            id: true,
            number: true,
            status: true,
          },
        },
      },
    });
  });

  await writeAudit(req, {
    tableName: 'journal_entries',
    recordId: stornoEntry.id,
    action: 'STORNO',
    reason: parsed.data.reason,
    afterData: {
      id: stornoEntry.id,
      number: stornoEntry.number,
      status: stornoEntry.status,
      reversalOfEntryId: stornoEntry.reversalOfEntryId,
    },
  });

  invalidateFinancialStatementsCache();
  res.status(201).json(stornoEntry);
});

export default router;
