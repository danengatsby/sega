import type { Prisma } from '@prisma/client';
import { DepreciationMethod } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { invalidateFinancialStatementsCache } from '../lib/financial-statements-cache.js';
import { nextJournalEntryNumber } from '../lib/journal-entry-number.js';
import { parseListQuery, setPaginationHeaders } from '../lib/list-query.js';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from '../lib/audit.js';
import { HttpError } from '../lib/http-error.js';
import { assertPeriodOpen } from '../lib/period-lock.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions } from '../middleware/auth.js';
import { currentPeriod } from '../utils/accounting.js';
import { monthDiffUTC, parsePeriod, periodToDateRange } from '../utils/period.js';
import { round2, toNumber } from '../utils/number.js';

const router = Router();

const createAssetSchema = z.object({
  code: z.string().optional(),
  name: z.string().min(2),
  value: z.coerce.number().positive(),
  residualValue: z.coerce.number().min(0).default(0),
  depreciationMethod: z.enum(['LINEAR', 'DEGRESSIVE', 'ACCELERATED']),
  startDate: z.string().datetime(),
  usefulLifeMonths: z.coerce.number().int().positive(),
  reason: z.string().optional(),
});

const runDepreciationSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  depreciationDate: z.string().datetime().optional(),
  autoPost: z.boolean().default(true),
  expenseAccountCode: z.string().default('681'),
  accumulatedDepreciationAccountCode: z.string().default('281'),
  reason: z.string().optional(),
});

function computeDepreciation(
  asset: {
    value: number;
    residualValue: number;
    usefulLifeMonths: number;
    depreciationMethod: DepreciationMethod;
  },
  monthIndex: number,
  accumulatedBefore: number,
): number {
  const depreciable = round2(asset.value - asset.residualValue);
  const remaining = round2(depreciable - accumulatedBefore);

  if (remaining <= 0 || monthIndex < 0 || monthIndex >= asset.usefulLifeMonths) {
    return 0;
  }

  const linearMonthly = round2(depreciable / asset.usefulLifeMonths);

  let amount = linearMonthly;

  if (asset.depreciationMethod === DepreciationMethod.DEGRESSIVE) {
    const remainingMonths = Math.max(asset.usefulLifeMonths - monthIndex, 1);
    amount = round2((remaining / remainingMonths) * 1.25);
  }

  if (asset.depreciationMethod === DepreciationMethod.ACCELERATED) {
    if (monthIndex === 0) {
      amount = round2(depreciable * 0.5);
    } else {
      const remainingMonths = Math.max(asset.usefulLifeMonths - monthIndex, 1);
      amount = round2(remaining / remainingMonths);
    }
  }

  return round2(Math.min(Math.max(amount, 0), remaining));
}

const assetSortFields = ['isActive', 'name', 'code', 'value', 'startDate', 'usefulLifeMonths', 'createdAt'] as const;
type AssetSortField = (typeof assetSortFields)[number];

function buildAssetOrderBy(
  sortField: AssetSortField,
  sortDirection: Prisma.SortOrder,
): Prisma.AssetOrderByWithRelationInput[] {
  switch (sortField) {
    case 'code':
      return [{ code: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'value':
      return [{ value: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'startDate':
      return [{ startDate: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'usefulLifeMonths':
      return [{ usefulLifeMonths: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'createdAt':
      return [{ createdAt: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'name':
      return [{ name: sortDirection }, { id: 'asc' }];
    case 'isActive':
    default:
      return [{ isActive: sortDirection }, { name: 'asc' }, { id: 'asc' }];
  }
}

router.get('/', requirePermissions(PERMISSIONS.ASSETS_READ), async (req, res) => {
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: assetSortFields,
    defaultSortField: 'isActive',
    defaultSortDirection: 'desc',
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  const baseWhere: Prisma.AssetWhereInput = {
    companyId: req.user!.companyId!,
  };

  const searchWhere: Prisma.AssetWhereInput | undefined = query.search
    ? {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { code: { contains: query.search, mode: 'insensitive' } },
        ],
      }
    : undefined;

  const where: Prisma.AssetWhereInput = searchWhere
    ? {
        AND: [baseWhere, searchWhere],
      }
    : baseWhere;

  const orderBy = buildAssetOrderBy(query.sortField, query.sortDirection);

  const [assets, totalCount] = await Promise.all([
    prisma.asset.findMany({
      where,
      include: {
        depreciationRecords: {
          orderBy: [{ period: 'desc' }],
          take: 24,
        },
      },
      orderBy,
      skip: query.skip,
      take: query.take,
    }),
    prisma.asset.count({ where }),
  ]);

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(assets);
});

router.post('/', requirePermissions(PERMISSIONS.ASSETS_WRITE), async (req, res) => {
  const parsed = createAssetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru mijloc fix.' });
    return;
  }

  if (parsed.data.residualValue >= parsed.data.value) {
    res.status(400).json({ message: 'Valoarea reziduală trebuie să fie mai mică decât valoarea de intrare.' });
    return;
  }

  const asset = await prisma.asset.create({
    data: {
      companyId: req.user!.companyId!,
      code: parsed.data.code,
      name: parsed.data.name,
      value: parsed.data.value,
      residualValue: parsed.data.residualValue,
      depreciationMethod: parsed.data.depreciationMethod,
      startDate: new Date(parsed.data.startDate),
      usefulLifeMonths: parsed.data.usefulLifeMonths,
      isActive: true,
    },
  });

  await writeAudit(req, {
    tableName: 'assets',
    recordId: asset.id,
    action: 'CREATE',
    reason: parsed.data.reason,
    afterData: asset,
  });

  invalidateFinancialStatementsCache();

  res.status(201).json(asset);
});

router.post(
  '/run-depreciation',
  requirePermissions(PERMISSIONS.ASSETS_RUN_DEPRECIATION),
  async (req, res) => {
    const parsed = runDepreciationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Date invalide pentru rularea amortizării.' });
      return;
    }

    parsePeriod(parsed.data.period);
    await assertPeriodOpen(req.user!.companyId!, parsed.data.period);
    const { end } = periodToDateRange(parsed.data.period);
    const depreciationDate = parsed.data.depreciationDate ? new Date(parsed.data.depreciationDate) : end;

    const assets = await prisma.asset.findMany({
      where: {
        companyId: req.user!.companyId!,
        isActive: true,
        startDate: {
          lte: end,
        },
      },
      include: {
        depreciationRecords: {
          orderBy: [{ period: 'asc' }],
        },
      },
    });

    if (assets.length === 0) {
      res.status(400).json({ message: 'Nu există active eligibile pentru amortizare.' });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const plannedRecords: Array<{
        assetId: string;
        period: string;
        depreciationDate: Date;
        depreciationAmount: number;
        accumulatedAmount: number;
        bookValue: number;
      }> = [];

      for (const asset of assets) {
        const existingForPeriod = asset.depreciationRecords.find((record) => record.period === parsed.data.period);
        if (existingForPeriod) {
          continue;
        }

        const monthIndex = monthDiffUTC(asset.startDate, end);
        const accumulatedBefore = round2(
          asset.depreciationRecords.reduce((sum, item) => sum + toNumber(item.depreciationAmount), 0),
        );

        const depreciationAmount = computeDepreciation(
          {
            value: toNumber(asset.value),
            residualValue: toNumber(asset.residualValue),
            usefulLifeMonths: asset.usefulLifeMonths,
            depreciationMethod: asset.depreciationMethod,
          },
          monthIndex,
          accumulatedBefore,
        );

        if (depreciationAmount <= 0) {
          continue;
        }

        const accumulatedAmount = round2(accumulatedBefore + depreciationAmount);
        const bookValue = round2(Math.max(toNumber(asset.value) - accumulatedAmount, toNumber(asset.residualValue)));

        plannedRecords.push({
          assetId: asset.id,
          period: parsed.data.period,
          depreciationDate,
          depreciationAmount,
          accumulatedAmount,
          bookValue,
        });
      }

      if (plannedRecords.length === 0) {
        return { records: [], journalEntryId: null as string | null };
      }

      let journalEntryId: string | null = null;

      if (parsed.data.autoPost) {
        const [expenseAccount, accumulatedDepAccount] = await Promise.all([
          tx.account.findFirst({
            where: {
              companyId: req.user!.companyId!,
              code: parsed.data.expenseAccountCode,
            },
          }),
          tx.account.findFirst({
            where: {
              companyId: req.user!.companyId!,
              code: parsed.data.accumulatedDepreciationAccountCode,
            },
          }),
        ]);

        if (!expenseAccount || !accumulatedDepAccount) {
          throw HttpError.badRequest('Conturile pentru postare amortizare lipsesc sau sunt invalide.');
        }

        const totalDepreciation = round2(
          plannedRecords.reduce((sum, item) => sum + item.depreciationAmount, 0),
        );

        const journalNumber = await nextJournalEntryNumber(tx, req.user!.companyId!, depreciationDate);
        const journalEntry = await tx.journalEntry.create({
          data: {
            companyId: req.user!.companyId!,
            number: journalNumber,
            date: depreciationDate,
            description: `Amortizare lunară ${parsed.data.period}`,
            period: parsed.data.period || currentPeriod(depreciationDate),
            sourceModule: 'FIXED_ASSETS',
            createdById: req.user!.id,
            lines: {
              create: [
                {
                  accountId: expenseAccount.id,
                  debit: totalDepreciation,
                  credit: 0,
                  explanation: `Cheltuială amortizare ${parsed.data.period}`,
                },
                {
                  accountId: accumulatedDepAccount.id,
                  debit: 0,
                  credit: totalDepreciation,
                  explanation: `Amortizare cumulată ${parsed.data.period}`,
                },
              ],
            },
          },
        });

        journalEntryId = journalEntry.id;
      }

      const createdRecords = await Promise.all(
        plannedRecords.map((record) =>
          tx.assetDepreciation.create({
            data: {
              ...record,
              journalEntryId: journalEntryId ?? undefined,
            },
          }),
        ),
      );

      return {
        records: createdRecords,
        journalEntryId,
      };
    });

    await writeAudit(req, {
      tableName: 'asset_depreciation',
      action: 'CREATE',
      reason: parsed.data.reason,
      afterData: {
        period: parsed.data.period,
        recordsGenerated: result.records.length,
        journalEntryId: result.journalEntryId,
      },
    });

    invalidateFinancialStatementsCache();

    res.status(201).json(result);
  },
);

export default router;
