import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { invalidateFinancialStatementsCache } from '../lib/financial-statements-cache.js';
import { parseListQuery, setPaginationHeaders } from '../lib/list-query.js';
import { prisma } from '../lib/prisma.js';
import { writeAudit } from '../lib/audit.js';
import { requirePermissions } from '../middleware/auth.js';
import { PERMISSIONS } from '../lib/rbac.js';

const router = Router();

const createSchema = z.object({
  cnp: z.string().min(8),
  name: z.string().min(2),
  contractType: z.string().default('CIM'),
  grossSalary: z.coerce.number().positive(),
  personalDeduction: z.coerce.number().min(0).default(0),
  hiredAt: z.string().datetime().optional(),
  reason: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().min(2).optional(),
  contractType: z.string().min(2).optional(),
  grossSalary: z.coerce.number().positive().optional(),
  personalDeduction: z.coerce.number().min(0).optional(),
  isActive: z.boolean().optional(),
  reason: z.string().min(3),
});

const employeeSortFields = ['isActive', 'name', 'cnp', 'contractType', 'grossSalary', 'hiredAt', 'createdAt'] as const;
type EmployeeSortField = (typeof employeeSortFields)[number];

function buildEmployeeOrderBy(
  sortField: EmployeeSortField,
  sortDirection: Prisma.SortOrder,
): Prisma.EmployeeOrderByWithRelationInput[] {
  switch (sortField) {
    case 'cnp':
      return [{ cnp: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'contractType':
      return [{ contractType: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'grossSalary':
      return [{ grossSalary: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'hiredAt':
      return [{ hiredAt: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'createdAt':
      return [{ createdAt: sortDirection }, { name: 'asc' }, { id: 'asc' }];
    case 'name':
      return [{ name: sortDirection }, { id: 'asc' }];
    case 'isActive':
    default:
      return [{ isActive: sortDirection }, { name: 'asc' }, { id: 'asc' }];
  }
}

router.get('/', requirePermissions(PERMISSIONS.EMPLOYEES_READ), async (req, res) => {
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: employeeSortFields,
    defaultSortField: 'isActive',
    defaultSortDirection: 'desc',
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  const baseWhere: Prisma.EmployeeWhereInput = {
    companyId: req.user!.companyId!,
  };

  const searchWhere: Prisma.EmployeeWhereInput | undefined = query.search
    ? {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { cnp: { contains: query.search, mode: 'insensitive' } },
          { contractType: { contains: query.search, mode: 'insensitive' } },
        ],
      }
    : undefined;

  const where: Prisma.EmployeeWhereInput = searchWhere
    ? {
        AND: [baseWhere, searchWhere],
      }
    : baseWhere;

  const orderBy = buildEmployeeOrderBy(query.sortField, query.sortDirection);

  const [employees, totalCount] = await Promise.all([
    prisma.employee.findMany({
      where,
      orderBy,
      skip: query.skip,
      take: query.take,
    }),
    prisma.employee.count({ where }),
  ]);

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(employees);
});

router.post('/', requirePermissions(PERMISSIONS.EMPLOYEES_WRITE), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru angajat.' });
    return;
  }

  const employee = await prisma.employee.create({
    data: {
      companyId: req.user!.companyId!,
      cnp: parsed.data.cnp,
      name: parsed.data.name,
      contractType: parsed.data.contractType,
      grossSalary: parsed.data.grossSalary,
      personalDeduction: parsed.data.personalDeduction,
      hiredAt: parsed.data.hiredAt ? new Date(parsed.data.hiredAt) : undefined,
    },
  });

  await writeAudit(req, {
    tableName: 'employees',
    recordId: employee.id,
    action: 'CREATE',
    reason: parsed.data.reason,
    afterData: employee,
  });

  invalidateFinancialStatementsCache();

  res.status(201).json(employee);
});

router.patch('/:id', requirePermissions(PERMISSIONS.EMPLOYEES_WRITE), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru actualizare angajat.' });
    return;
  }

  const employeeId = String(req.params.id);
  const existing = await prisma.employee.findFirst({
    where: {
      id: employeeId,
      companyId: req.user!.companyId!,
    },
  });
  if (!existing) {
    res.status(404).json({ message: 'Angajat inexistent.' });
    return;
  }

  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: {
      name: parsed.data.name,
      contractType: parsed.data.contractType,
      grossSalary: parsed.data.grossSalary,
      personalDeduction: parsed.data.personalDeduction,
      isActive: parsed.data.isActive,
    },
  });

  await writeAudit(req, {
    tableName: 'employees',
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
