import { AccountType, type Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { invalidateFinancialStatementsCache } from '../lib/financial-statements-cache.js';
import { parseListQuery, setPaginationHeaders } from '../lib/list-query.js';
import { prisma } from '../lib/prisma.js';
import { requirePermissions } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { buildSimplePdf } from '../utils/pdf.js';

const router = Router();
const accountSortFields = ['code', 'name', 'type', 'createdAt'] as const;
type AccountSortField = (typeof accountSortFields)[number];
const accountTypeValues = new Set<AccountType>(Object.values(AccountType));

const createSchema = z.object({
  code: z.string().min(3),
  name: z.string().min(2),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  currency: z.string().default('RON'),
  reason: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']).optional(),
  currency: z.string().optional(),
  isActive: z.boolean().optional(),
  reason: z.string().min(3),
});

function buildAccountOrderBy(
  sortField: AccountSortField,
  sortDirection: Prisma.SortOrder,
): Prisma.AccountOrderByWithRelationInput[] {
  switch (sortField) {
    case 'name':
      return [{ name: sortDirection }, { code: 'asc' }];
    case 'type':
      return [{ type: sortDirection }, { code: 'asc' }];
    case 'createdAt':
      return [{ createdAt: sortDirection }, { code: 'asc' }];
    case 'code':
    default:
      return [{ code: sortDirection }];
  }
}

function accountTypeLabel(type: AccountType): string {
  switch (type) {
    case AccountType.ASSET:
      return 'Activ';
    case AccountType.LIABILITY:
      return 'Pasiv';
    case AccountType.EQUITY:
      return 'Capital';
    case AccountType.REVENUE:
      return 'Venit';
    case AccountType.EXPENSE:
      return 'Cheltuiala';
    default:
      return type;
  }
}

router.get('/export/pdf', requirePermissions(PERMISSIONS.ACCOUNTS_READ), async (req, res) => {
  const companyId = req.user!.companyId!;
  const company = await prisma.company.findUnique({
    where: {
      id: companyId,
    },
    select: {
      code: true,
      name: true,
    },
  });

  const accounts = await prisma.account.findMany({
    where: {
      companyId,
    },
    orderBy: [{ code: 'asc' }, { name: 'asc' }],
    select: {
      code: true,
      name: true,
      type: true,
      currency: true,
      isActive: true,
    },
  });

  const generatedAt = new Date().toLocaleString('ro-RO');
  const lines: string[] = [
    'SEGA Accounting - Lista plan de conturi',
    `Companie: ${company?.name ?? req.user?.companyName ?? 'N/A'} (${company?.code ?? req.user?.companyCode ?? 'N/A'})`,
    `Generat la: ${generatedAt}`,
    `Total conturi: ${accounts.length}`,
    '',
    'Cod | Denumire | Tip | Moneda | Activ',
    '------------------------------------------------------------',
    ...accounts.map(
      (account) =>
        `${account.code} | ${account.name} | ${accountTypeLabel(account.type)} | ${account.currency} | ${account.isActive ? 'DA' : 'NU'}`,
    ),
  ];

  const pdf = buildSimplePdf(lines);
  const safeCompanyCode = (company?.code ?? req.user?.companyCode ?? 'companie')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="plan-conturi-${safeCompanyCode}.pdf"`);
  res.send(pdf);
});

router.get('/', requirePermissions(PERMISSIONS.ACCOUNTS_READ), async (req, res) => {
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: accountSortFields,
    defaultSortField: 'code',
    defaultSortDirection: 'asc',
    defaultPageSize: 50,
    maxPageSize: 200,
    defaultPaginationEnabled: false,
  });

  const baseWhere: Prisma.AccountWhereInput = {
    companyId: req.user!.companyId!,
  };

  const searchedType = query.search?.toUpperCase();
  const whereOrConditions: Prisma.AccountWhereInput[] = query.search
    ? [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { currency: { contains: query.search, mode: 'insensitive' } },
      ]
    : [];

  if (searchedType && accountTypeValues.has(searchedType as AccountType)) {
    whereOrConditions.push({ type: searchedType as AccountType });
  }

  const where: Prisma.AccountWhereInput =
    whereOrConditions.length > 0
      ? {
          AND: [
            baseWhere,
            {
              OR: whereOrConditions,
            },
          ],
        }
      : baseWhere;

  const accountsPromise = prisma.account.findMany({
    where,
    orderBy: buildAccountOrderBy(query.sortField, query.sortDirection),
    skip: query.skip,
    take: query.take,
  });

  const [accounts, totalCount] = query.paginationEnabled
    ? await Promise.all([accountsPromise, prisma.account.count({ where })])
    : [await accountsPromise, 0];

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(accounts);
});

router.post('/', requirePermissions(PERMISSIONS.ACCOUNTS_WRITE), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru cont.' });
    return;
  }

  const account = await prisma.account.create({
    data: {
      companyId: req.user!.companyId!,
      code: parsed.data.code,
      name: parsed.data.name,
      type: parsed.data.type,
      currency: parsed.data.currency,
    },
  });

  await writeAudit(req, {
    tableName: 'accounts',
    recordId: account.id,
    action: 'CREATE',
    reason: parsed.data.reason,
    afterData: account,
  });

  invalidateFinancialStatementsCache();

  res.status(201).json(account);
});

router.patch('/:id', requirePermissions(PERMISSIONS.ACCOUNTS_WRITE), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru actualizare cont.' });
    return;
  }

  const accountId = String(req.params.id);

  const existing = await prisma.account.findFirst({
    where: {
      id: accountId,
      companyId: req.user!.companyId!,
    },
  });
  if (!existing) {
    res.status(404).json({ message: 'Cont inexistent.' });
    return;
  }

  const updated = await prisma.account.update({
    where: { id: accountId },
    data: {
      name: parsed.data.name,
      type: parsed.data.type,
      currency: parsed.data.currency,
      isActive: parsed.data.isActive,
    },
  });

  await writeAudit(req, {
    tableName: 'accounts',
    recordId: updated.id,
    action: 'UPDATE',
    reason: parsed.data.reason,
    beforeData: existing,
    afterData: updated,
  });

  invalidateFinancialStatementsCache();

  res.json(updated);
});

export default router;
