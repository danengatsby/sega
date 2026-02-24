import type { Prisma } from '@prisma/client';
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

const createSchema = z.object({
  name: z.string().min(2),
  cui: z.string().optional(),
  iban: z.string().optional(),
  type: z.enum(['CUSTOMER', 'SUPPLIER', 'BOTH']),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  reason: z.string().optional(),
});

const partnerSortFields = ['name', 'cui', 'type', 'createdAt'] as const;
type PartnerSortField = (typeof partnerSortFields)[number];

function partnerTypeLabel(type: 'CUSTOMER' | 'SUPPLIER' | 'BOTH'): string {
  switch (type) {
    case 'CUSTOMER':
      return 'Client';
    case 'SUPPLIER':
      return 'Furnizor';
    case 'BOTH':
      return 'Client + Furnizor';
    default:
      return type;
  }
}

function buildPartnerOrderBy(
  sortField: PartnerSortField,
  sortDirection: Prisma.SortOrder,
): Prisma.PartnerOrderByWithRelationInput[] {
  switch (sortField) {
    case 'cui':
      return [{ cui: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'type':
      return [{ type: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'createdAt':
      return [{ createdAt: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'name':
    default:
      return [{ name: sortDirection }, { id: 'asc' }];
  }
}

router.get('/export/pdf', requirePermissions(PERMISSIONS.PARTNERS_READ), async (req, res) => {
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

  const partners = await prisma.partner.findMany({
    where: {
      companyId,
    },
    orderBy: [{ name: 'asc' }, { createdAt: 'desc' }],
    select: {
      name: true,
      cui: true,
      iban: true,
      type: true,
      email: true,
      phone: true,
    },
  });

  const generatedAt = new Date().toLocaleString('ro-RO');
  const lines: string[] = [
    'SEGA Accounting - Lista parteneri',
    `Companie: ${company?.name ?? req.user?.companyName ?? 'N/A'} (${company?.code ?? req.user?.companyCode ?? 'N/A'})`,
    `Generat la: ${generatedAt}`,
    `Total parteneri: ${partners.length}`,
    '',
    'Nume | CUI | Tip | Email | Telefon | IBAN',
    '--------------------------------------------------------------------------------------------------------------',
    ...partners.map((partner) => {
      const name = partner.name.trim();
      const cui = (partner.cui ?? '-').trim() || '-';
      const type = partnerTypeLabel(partner.type);
      const email = (partner.email ?? '-').trim() || '-';
      const phone = (partner.phone ?? '-').trim() || '-';
      const iban = (partner.iban ?? '-').trim() || '-';

      return `${name} | ${cui} | ${type} | ${email} | ${phone} | ${iban}`;
    }),
  ];

  const pdf = buildSimplePdf(lines);
  const safeCompanyCode = (company?.code ?? req.user?.companyCode ?? 'companie')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="parteneri-${safeCompanyCode}.pdf"`);
  res.send(pdf);
});

router.get('/', requirePermissions(PERMISSIONS.PARTNERS_READ), async (req, res) => {
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: partnerSortFields,
    defaultSortField: 'name',
    defaultSortDirection: 'asc',
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  const baseWhere: Prisma.PartnerWhereInput = {
    companyId: req.user!.companyId!,
  };

  const searchWhere: Prisma.PartnerWhereInput | undefined = query.search
    ? {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { cui: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search, mode: 'insensitive' } },
          { iban: { contains: query.search, mode: 'insensitive' } },
        ],
      }
    : undefined;

  const where: Prisma.PartnerWhereInput = searchWhere
    ? {
        AND: [baseWhere, searchWhere],
      }
    : baseWhere;

  const orderBy = buildPartnerOrderBy(query.sortField, query.sortDirection);

  const [partners, totalCount] = await Promise.all([
    prisma.partner.findMany({
      where,
      orderBy,
      skip: query.skip,
      take: query.take,
    }),
    prisma.partner.count({ where }),
  ]);

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(partners);
});

router.post('/', requirePermissions(PERMISSIONS.PARTNERS_WRITE), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru partener.' });
    return;
  }

  const { reason, ...partnerData } = parsed.data;

  const partner = await prisma.partner.create({
    data: {
      ...partnerData,
      companyId: req.user!.companyId!,
    },
  });

  await writeAudit(req, {
    tableName: 'partners',
    recordId: partner.id,
    action: 'CREATE',
    reason,
    afterData: partner,
  });

  invalidateFinancialStatementsCache();

  res.status(201).json(partner);
});

export default router;
