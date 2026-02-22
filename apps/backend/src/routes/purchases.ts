import type { Prisma } from '@prisma/client';
import {
  ApprovalChannel,
  ApprovalDelegationScope,
  PartnerType,
  Role,
  SupplierInvoiceApprovalActionType,
  SupplierInvoiceApprovalStatus,
  SupplierInvoiceStatus,
} from '@prisma/client';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { invalidateFinancialStatementsCache } from '../lib/financial-statements-cache.js';
import { HttpError } from '../lib/http-error.js';
import { nextJournalEntryNumber } from '../lib/journal-entry-number.js';
import { parseListQuery, setPaginationHeaders } from '../lib/list-query.js';
import { logger } from '../lib/logger.js';
import { enqueueNotificationEvent } from '../lib/notification-queue.js';
import { assertPeriodOpen } from '../lib/period-lock.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { writeAudit } from '../lib/audit.js';
import { requirePermissions } from '../middleware/auth.js';
import { currentPeriod } from '../utils/accounting.js';
import { round2, toNumber } from '../utils/number.js';

const router = Router();

const createSupplierInvoiceSchema = z.object({
  number: z.string().min(1),
  supplierId: z.string().min(1),
  receivedDate: z.string().datetime().optional(),
  dueDate: z.string().datetime(),
  currency: z.string().default('RON'),
  subtotal: z.coerce.number().positive(),
  vat: z.coerce.number().min(0),
  description: z.string().optional(),
  autoPost: z.boolean().default(true),
  expenseAccountCode: z.string().default('601'),
  deductibleVatAccountCode: z.string().default('4426'),
  payableAccountCode: z.string().default('401'),
  reason: z.string().optional(),
});

const supplierPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(['BANK_TRANSFER', 'CASH', 'CARD', 'OTHER']).default('BANK_TRANSFER'),
  date: z.string().datetime().optional(),
  reference: z.string().optional(),
  autoPost: z.boolean().default(true),
  bankAccountCode: z.string().default('5121'),
  payableAccountCode: z.string().default('401'),
  reason: z.string().optional(),
});

const supplierApprovalActionSchema = z.object({
  note: z.string().max(500).optional(),
  reason: z.string().optional(),
});

const supplierRejectSchema = z.object({
  reason: z.string().min(5).max(500),
  note: z.string().max(500).optional(),
});

const approvalDelegationSchema = z
  .object({
    fromUserId: z.string().min(1).optional(),
    toUserId: z.string().min(1),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime(),
    reason: z.string().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    const startsAt = value.startsAt ? new Date(value.startsAt) : new Date();
    const endsAt = new Date(value.endsAt);
    if (Number.isNaN(startsAt.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startsAt invalid',
        path: ['startsAt'],
      });
    }
    if (Number.isNaN(endsAt.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endsAt invalid',
        path: ['endsAt'],
      });
    }
    if (!Number.isNaN(startsAt.getTime()) && !Number.isNaN(endsAt.getTime()) && endsAt.getTime() <= startsAt.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endsAt must be after startsAt',
        path: ['endsAt'],
      });
    }
  });

const supplierInvoiceSortFields = [
  'receivedDate',
  'dueDate',
  'number',
  'total',
  'status',
  'createdAt',
  'supplierName',
] as const;

type SupplierInvoiceSortField = (typeof supplierInvoiceSortFields)[number];

const supplierInvoiceStatusValues = new Set<SupplierInvoiceStatus>(Object.values(SupplierInvoiceStatus));
const openSupplierInvoiceStatuses: SupplierInvoiceStatus[] = [
  SupplierInvoiceStatus.RECEIVED,
  SupplierInvoiceStatus.PARTIALLY_PAID,
];
const LEVEL_4_APPROVAL_THRESHOLD_RON = 50_000;
const AP_APPROVER_ROLES = [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER] as const;
const approvalStatusByLevel: Record<number, SupplierInvoiceApprovalStatus> = {
  1: SupplierInvoiceApprovalStatus.PENDING_LEVEL_1,
  2: SupplierInvoiceApprovalStatus.PENDING_LEVEL_2,
  3: SupplierInvoiceApprovalStatus.PENDING_LEVEL_3,
  4: SupplierInvoiceApprovalStatus.PENDING_LEVEL_4,
};
const requiredRolesByLevel: Record<number, Role[]> = {
  1: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  2: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.MANAGER],
  3: [Role.ADMIN, Role.CHIEF_ACCOUNTANT],
  4: [Role.ADMIN, Role.CHIEF_ACCOUNTANT],
};

function resolveRequiredApprovalLevel(total: number): number {
  return total >= LEVEL_4_APPROVAL_THRESHOLD_RON ? 4 : 3;
}

function isRoleAllowedForLevel(role: Role, level: number): boolean {
  return (requiredRolesByLevel[level] ?? []).includes(role);
}

async function resolveApprovalActor(
  tx: Prisma.TransactionClient,
  params: {
    companyId: string;
    actingUserId: string;
    actingRole: Role;
    level: number;
    now: Date;
  },
): Promise<{ approvedById: string; delegatedFromUserId: string | null }> {
  if (isRoleAllowedForLevel(params.actingRole, params.level)) {
    return {
      approvedById: params.actingUserId,
      delegatedFromUserId: null,
    };
  }

  const delegation = await tx.approvalDelegation.findFirst({
    where: {
      companyId: params.companyId,
      scope: ApprovalDelegationScope.PURCHASES_SUPPLIER_INVOICE_APPROVAL,
      toUserId: params.actingUserId,
      isActive: true,
      startsAt: {
        lte: params.now,
      },
      endsAt: {
        gte: params.now,
      },
    },
    include: {
      fromUser: {
        include: {
          memberships: {
            where: {
              companyId: params.companyId,
            },
            select: {
              role: true,
            },
            take: 1,
          },
        },
      },
    },
    orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }],
  });

  const delegatedFromRole = delegation?.fromUser.memberships[0]?.role;
  if (delegation && delegatedFromRole && isRoleAllowedForLevel(delegatedFromRole, params.level)) {
    return {
      approvedById: params.actingUserId,
      delegatedFromUserId: delegation.fromUserId,
    };
  }

  throw HttpError.forbidden(
    `Nu ai drept de aprobare pentru nivelul ${params.level}. Este necesar rolul potrivit sau o delegare activă.`,
  );
}

function levelToPendingStatus(level: number): SupplierInvoiceApprovalStatus {
  return approvalStatusByLevel[level] ?? SupplierInvoiceApprovalStatus.PENDING_LEVEL_4;
}

function buildSupplierInvoiceOrderBy(
  sortField: SupplierInvoiceSortField,
  sortDirection: Prisma.SortOrder,
): Prisma.SupplierInvoiceOrderByWithRelationInput[] {
  switch (sortField) {
    case 'dueDate':
      return [{ dueDate: sortDirection }, { receivedDate: 'desc' }, { id: 'desc' }];
    case 'number':
      return [{ number: sortDirection }, { receivedDate: 'desc' }, { id: 'desc' }];
    case 'total':
      return [{ total: sortDirection }, { receivedDate: 'desc' }, { id: 'desc' }];
    case 'status':
      return [{ status: sortDirection }, { receivedDate: 'desc' }, { id: 'desc' }];
    case 'createdAt':
      return [{ createdAt: sortDirection }, { receivedDate: 'desc' }, { id: 'desc' }];
    case 'supplierName':
      return [{ supplier: { name: sortDirection } }, { receivedDate: 'desc' }, { id: 'desc' }];
    case 'receivedDate':
    default:
      return [{ receivedDate: sortDirection }, { id: 'desc' }];
  }
}

router.get('/invoices', requirePermissions(PERMISSIONS.PURCHASES_READ), async (req, res) => {
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: supplierInvoiceSortFields,
    defaultSortField: 'receivedDate',
    defaultSortDirection: 'desc',
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  const searchedStatus = query.search?.toUpperCase();
  const whereOrConditions: Prisma.SupplierInvoiceWhereInput[] = query.search
    ? [
        { number: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { supplier: { name: { contains: query.search, mode: 'insensitive' } } },
        { supplier: { cui: { contains: query.search, mode: 'insensitive' } } },
      ]
    : [];

  if (searchedStatus && supplierInvoiceStatusValues.has(searchedStatus as SupplierInvoiceStatus)) {
    whereOrConditions.push({ status: searchedStatus as SupplierInvoiceStatus });
  }

  const baseWhere: Prisma.SupplierInvoiceWhereInput = {
    companyId: req.user!.companyId!,
  };

  const searchWhere: Prisma.SupplierInvoiceWhereInput | undefined =
    whereOrConditions.length > 0
      ? {
          OR: whereOrConditions,
        }
      : undefined;

  const where: Prisma.SupplierInvoiceWhereInput = searchWhere
    ? {
        AND: [baseWhere, searchWhere],
      }
    : baseWhere;

  const orderBy = buildSupplierInvoiceOrderBy(query.sortField, query.sortDirection);

  const [invoices, totalCount] = await Promise.all([
    prisma.supplierInvoice.findMany({
      where,
      include: {
        supplier: true,
        payments: true,
        approvals: {
          orderBy: [{ createdAt: 'desc' }],
          take: 30,
          include: {
            approvedBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            delegatedFrom: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy,
      skip: query.skip,
      take: query.take,
    }),
    prisma.supplierInvoice.count({ where }),
  ]);

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(invoices);
});

router.post('/invoices', requirePermissions(PERMISSIONS.PURCHASES_WRITE), async (req, res) => {
  const parsed = createSupplierInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru factura de furnizor.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const receivedDate = parsed.data.receivedDate ? new Date(parsed.data.receivedDate) : new Date();
  const dueDate = new Date(parsed.data.dueDate);
  if (dueDate.getTime() < receivedDate.getTime()) {
    res.status(400).json({ message: 'Data scadenței trebuie să fie mai mare sau egală cu data recepției.' });
    return;
  }
  const total = round2(parsed.data.subtotal + parsed.data.vat);
  const requiredApprovalLevel = resolveRequiredApprovalLevel(total);
  const period = currentPeriod(receivedDate);
  await assertPeriodOpen(companyId, period);

  const missingAccountsMessage = 'Conturi implicite lipsă pentru postarea automată a facturii de furnizor.';

  const invoice = await prisma.$transaction(async (tx) => {
    const supplier = await tx.partner.findFirst({
      where: {
        id: parsed.data.supplierId,
        companyId,
        type: {
          in: [PartnerType.SUPPLIER, PartnerType.BOTH],
        },
      },
      select: {
        id: true,
      },
    });

    if (!supplier) {
      throw HttpError.badRequest('Furnizor inexistent în compania activă sau tip invalid.');
    }

    let expenseAccountId: string | null = null;
    let deductibleVatAccountId: string | null = null;
    let payableAccountId: string | null = null;

    if (parsed.data.autoPost) {
      const [expenseAccount, deductibleVatAccount, payableAccount] = await Promise.all([
        tx.account.findFirst({
          where: {
            companyId,
            code: parsed.data.expenseAccountCode,
          },
        }),
        tx.account.findFirst({
          where: {
            companyId,
            code: parsed.data.deductibleVatAccountCode,
          },
        }),
        tx.account.findFirst({
          where: {
            companyId,
            code: parsed.data.payableAccountCode,
          },
        }),
      ]);

      if (!expenseAccount || !deductibleVatAccount || !payableAccount) {
        throw HttpError.badRequest(missingAccountsMessage);
      }

      expenseAccountId = expenseAccount.id;
      deductibleVatAccountId = deductibleVatAccount.id;
      payableAccountId = payableAccount.id;
    }

    const created = await tx.supplierInvoice.create({
      data: {
        companyId,
        number: parsed.data.number,
        supplierId: parsed.data.supplierId,
        receivedDate,
        dueDate,
        currency: parsed.data.currency,
        subtotal: parsed.data.subtotal,
        vat: parsed.data.vat,
        total,
        status: SupplierInvoiceStatus.RECEIVED,
        approvalStatus: SupplierInvoiceApprovalStatus.PENDING_LEVEL_1,
        approvalCurrentLevel: 1,
        approvalRequiredLevel: requiredApprovalLevel,
        approvalRequestedAt: new Date(),
        approvalFinalizedAt: null,
        approvalFinalizedById: null,
        approvalRejectedReason: null,
        description: parsed.data.description,
      },
      include: {
        supplier: true,
        payments: true,
        approvals: {
          orderBy: [{ createdAt: 'desc' }],
          take: 30,
          include: {
            approvedBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            delegatedFrom: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (parsed.data.autoPost) {
      const journalNumber = await nextJournalEntryNumber(tx, companyId, receivedDate);
      const lines: Array<{
        accountId: string;
        debit: number;
        credit: number;
        explanation: string;
      }> = [
        {
          accountId: expenseAccountId!,
          debit: parsed.data.subtotal,
          credit: 0,
          explanation: `Cheltuială factură furnizor ${created.number}`,
        },
        {
          accountId: payableAccountId!,
          debit: 0,
          credit: total,
          explanation: `Datorie furnizor ${created.number}`,
        },
      ];

      if (parsed.data.vat > 0) {
        lines.splice(1, 0, {
          accountId: deductibleVatAccountId!,
          debit: parsed.data.vat,
          credit: 0,
          explanation: `TVA deductibil ${created.number}`,
        });
      }

      await tx.journalEntry.create({
        data: {
          companyId,
          number: journalNumber,
          date: receivedDate,
          description: `Postare automată factură furnizor ${created.number}`,
          period,
          sourceModule: 'ACCOUNTS_PAYABLE',
          createdById: req.user!.id,
          lines: {
            create: lines,
          },
        },
      });
    }

    await writeAudit(
      req,
      {
        tableName: 'supplier_invoices',
        recordId: created.id,
        action: 'CREATE',
        reason: parsed.data.reason,
        afterData: {
          number: created.number,
          total: created.total,
          status: created.status,
          approvalStatus: created.approvalStatus,
          approvalCurrentLevel: created.approvalCurrentLevel,
          approvalRequiredLevel: created.approvalRequiredLevel,
        },
      },
      tx,
    );

    return created;
  });

  invalidateFinancialStatementsCache();
  void enqueueNotificationEvent({
    type: 'SUPPLIER_INVOICE_CREATED',
    companyId,
    companyName: req.user!.companyName,
    triggeredByUserId: req.user!.id,
    payload: {
      supplierInvoiceId: invoice.id,
      number: invoice.number,
      supplierName: invoice.supplier.name,
      total: toNumber(invoice.total),
      currency: invoice.currency,
      dueDate: invoice.dueDate.toISOString(),
      approvalStatus: invoice.approvalStatus,
    },
  }).catch((error) => {
    logger.warn('notification_enqueue_failed', {
      eventType: 'SUPPLIER_INVOICE_CREATED',
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  res.status(201).json(invoice);
});

router.get('/approvers', requirePermissions(PERMISSIONS.PURCHASES_READ), async (req, res) => {
  const companyId = req.user!.companyId!;

  const memberships = await prisma.userCompanyMembership.findMany({
    where: {
      companyId,
      role: {
        in: [...AP_APPROVER_ROLES],
      },
    },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
    orderBy: [{ role: 'asc' }, { user: { name: 'asc' } }],
  });

  res.json(
    memberships.map((membership) => ({
      id: membership.user.id,
      name: membership.user.name,
      email: membership.user.email,
      role: membership.role,
    })),
  );
});

router.get('/delegations', requirePermissions(PERMISSIONS.PURCHASES_READ), async (req, res) => {
  const companyId = req.user!.companyId!;
  const includeInactive = req.query.includeInactive === 'true';
  const now = new Date();

  const delegations = await prisma.approvalDelegation.findMany({
    where: {
      companyId,
      scope: ApprovalDelegationScope.PURCHASES_SUPPLIER_INVOICE_APPROVAL,
      ...(includeInactive
        ? {}
        : {
            isActive: true,
            startsAt: { lte: now },
            endsAt: { gte: now },
          }),
    },
    include: {
      fromUser: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      toUser: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
    orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  });

  res.json(delegations);
});

router.post('/delegations', requirePermissions(PERMISSIONS.PURCHASE_DELEGATE), async (req, res) => {
  const parsed = approvalDelegationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru delegarea aprobării.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const actingUserId = req.user!.id;
  const actingRole = req.user!.companyRole ?? req.user!.role;
  const startsAt = parsed.data.startsAt ? new Date(parsed.data.startsAt) : new Date();
  const endsAt = new Date(parsed.data.endsAt);
  const fromUserId = parsed.data.fromUserId?.trim() || actingUserId;
  const toUserId = parsed.data.toUserId.trim();

  if (toUserId === fromUserId) {
    throw HttpError.badRequest('Utilizatorul delegat trebuie să fie diferit de delegator.');
  }

  if (fromUserId !== actingUserId && actingRole !== Role.ADMIN) {
    throw HttpError.forbidden('Poți crea delegări doar pentru contul tău (exceptând ADMIN).');
  }

  const delegation = await prisma.$transaction(async (tx) => {
    const [fromMembership, toMembership] = await Promise.all([
      tx.userCompanyMembership.findFirst({
        where: {
          companyId,
          userId: fromUserId,
        },
        select: {
          role: true,
        },
      }),
      tx.userCompanyMembership.findFirst({
        where: {
          companyId,
          userId: toUserId,
        },
        select: {
          role: true,
        },
      }),
    ]);

    if (!fromMembership || !toMembership) {
      throw HttpError.badRequest('Delegarea necesită utilizatori care aparțin companiei active.');
    }

    const fromRole = fromMembership.role;
    if (!Object.values(requiredRolesByLevel).some((roles) => roles.includes(fromRole))) {
      throw HttpError.badRequest('Delegatorul selectat nu are drepturi de aprobare AP.');
    }

    const created = await tx.approvalDelegation.create({
      data: {
        companyId,
        scope: ApprovalDelegationScope.PURCHASES_SUPPLIER_INVOICE_APPROVAL,
        fromUserId,
        toUserId,
        startsAt,
        endsAt,
        isActive: true,
        reason: parsed.data.reason,
      },
      include: {
        fromUser: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        toUser: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'approval_delegations',
        recordId: created.id,
        action: 'CREATE',
        reason: parsed.data.reason ?? 'purchase-approval-delegation',
        afterData: {
          scope: created.scope,
          fromUserId: created.fromUserId,
          toUserId: created.toUserId,
          startsAt: created.startsAt,
          endsAt: created.endsAt,
        },
      },
      tx,
    );

    return created;
  });

  res.status(201).json(delegation);
});

async function approveSupplierInvoice(
  req: Request,
  res: Response,
  channel: ApprovalChannel,
): Promise<void> {
  const parsed = supplierApprovalActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru aprobarea facturii.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const invoiceId = String(req.params.id);
  const actingRole = req.user!.companyRole ?? req.user!.role;
  const now = new Date();

  const updatedInvoice = await prisma.$transaction(async (tx) => {
    const invoice = await tx.supplierInvoice.findFirst({
      where: {
        id: invoiceId,
        companyId,
      },
      include: {
        payments: true,
      },
    });

    if (!invoice) {
      throw HttpError.notFound('Factura de furnizor nu există.');
    }

    if (invoice.status === SupplierInvoiceStatus.CANCELLED || invoice.status === SupplierInvoiceStatus.PAID) {
      throw HttpError.badRequest(`Factura nu poate fi aprobată în statusul "${invoice.status}".`);
    }

    if (invoice.approvalStatus === SupplierInvoiceApprovalStatus.APPROVED) {
      throw HttpError.conflict('Factura este deja aprobată complet.');
    }

    if (invoice.approvalStatus === SupplierInvoiceApprovalStatus.REJECTED) {
      throw HttpError.badRequest('Factura a fost respinsă. Este necesară corecția și retrimiterea în flux.');
    }

    const currentLevel = Math.min(Math.max(invoice.approvalCurrentLevel, 1), 4);
    const requiredLevel = Math.min(Math.max(invoice.approvalRequiredLevel || 1, 1), 4);
    const actor = await resolveApprovalActor(tx, {
      companyId,
      actingUserId: req.user!.id,
      actingRole,
      level: currentLevel,
      now,
    });

    await tx.supplierInvoiceApproval.create({
      data: {
        companyId,
        supplierInvoiceId: invoice.id,
        level: currentLevel,
        action: SupplierInvoiceApprovalActionType.APPROVE,
        channel,
        note: parsed.data.note,
        approvedById: actor.approvedById,
        delegatedFromUserId: actor.delegatedFromUserId,
      },
    });

    const isFinalLevel = currentLevel >= requiredLevel;
    const nextLevel = Math.min(currentLevel + 1, 4);
    const invoiceData: Prisma.SupplierInvoiceUncheckedUpdateInput = isFinalLevel
      ? {
          approvalStatus: SupplierInvoiceApprovalStatus.APPROVED,
          approvalCurrentLevel: requiredLevel,
          approvalRequiredLevel: requiredLevel,
          approvalFinalizedAt: now,
          approvalFinalizedById: actor.approvedById,
          approvalRejectedReason: null,
        }
      : {
          approvalStatus: levelToPendingStatus(nextLevel),
          approvalCurrentLevel: nextLevel,
          approvalRequiredLevel: requiredLevel,
          approvalFinalizedAt: null,
          approvalFinalizedById: null,
          approvalRejectedReason: null,
        };

    const updated = await tx.supplierInvoice.update({
      where: { id: invoice.id },
      data: invoiceData,
      include: {
        supplier: true,
        payments: true,
        approvals: {
          orderBy: [{ createdAt: 'desc' }],
          take: 30,
          include: {
            approvedBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            delegatedFrom: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'supplier_invoices',
        recordId: invoice.id,
        action: channel === ApprovalChannel.MOBILE ? 'SUPPLIER_INVOICE_APPROVE_MOBILE' : 'SUPPLIER_INVOICE_APPROVE',
        reason: parsed.data.reason,
        afterData: {
          approvalStatus: updated.approvalStatus,
          approvalCurrentLevel: updated.approvalCurrentLevel,
          approvalRequiredLevel: updated.approvalRequiredLevel,
          delegatedFromUserId: actor.delegatedFromUserId,
        },
      },
      tx,
    );

    return updated;
  });

  res.json({
    invoice: updatedInvoice,
  });
}

router.post('/invoices/:id/approve', requirePermissions(PERMISSIONS.PURCHASE_APPROVE), async (req, res) => {
  await approveSupplierInvoice(req, res, ApprovalChannel.WEB);
});

router.post('/invoices/:id/approve/mobile', requirePermissions(PERMISSIONS.PURCHASE_APPROVE), async (req, res) => {
  await approveSupplierInvoice(req, res, ApprovalChannel.MOBILE);
});

router.post('/invoices/:id/reject', requirePermissions(PERMISSIONS.PURCHASE_APPROVE), async (req, res) => {
  const parsed = supplierRejectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru respingerea facturii.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const invoiceId = String(req.params.id);
  const actingRole = req.user!.companyRole ?? req.user!.role;
  const now = new Date();

  const updatedInvoice = await prisma.$transaction(async (tx) => {
    const invoice = await tx.supplierInvoice.findFirst({
      where: {
        id: invoiceId,
        companyId,
      },
      include: {
        payments: true,
      },
    });

    if (!invoice) {
      throw HttpError.notFound('Factura de furnizor nu există.');
    }

    if (invoice.status === SupplierInvoiceStatus.CANCELLED || invoice.status === SupplierInvoiceStatus.PAID) {
      throw HttpError.badRequest(`Factura nu poate fi respinsă în statusul "${invoice.status}".`);
    }

    if (invoice.approvalStatus === SupplierInvoiceApprovalStatus.APPROVED && invoice.payments.length > 0) {
      throw HttpError.badRequest('Factura deja aprobată și parțial plătită nu mai poate fi respinsă.');
    }

    if (invoice.approvalStatus === SupplierInvoiceApprovalStatus.REJECTED) {
      throw HttpError.conflict('Factura este deja respinsă.');
    }

    const currentLevel = Math.min(Math.max(invoice.approvalCurrentLevel, 1), 4);
    const actor = await resolveApprovalActor(tx, {
      companyId,
      actingUserId: req.user!.id,
      actingRole,
      level: currentLevel,
      now,
    });

    await tx.supplierInvoiceApproval.create({
      data: {
        companyId,
        supplierInvoiceId: invoice.id,
        level: currentLevel,
        action: SupplierInvoiceApprovalActionType.REJECT,
        channel: ApprovalChannel.WEB,
        note: parsed.data.note,
        approvedById: actor.approvedById,
        delegatedFromUserId: actor.delegatedFromUserId,
      },
    });

    const rejectUpdateData: Prisma.SupplierInvoiceUncheckedUpdateInput = {
      approvalStatus: SupplierInvoiceApprovalStatus.REJECTED,
      approvalFinalizedAt: now,
      approvalFinalizedById: actor.approvedById,
      approvalRejectedReason: parsed.data.reason,
    };

    const updated = await tx.supplierInvoice.update({
      where: { id: invoice.id },
      data: rejectUpdateData,
      include: {
        supplier: true,
        payments: true,
        approvals: {
          orderBy: [{ createdAt: 'desc' }],
          take: 30,
          include: {
            approvedBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            delegatedFrom: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'supplier_invoices',
        recordId: invoice.id,
        action: 'SUPPLIER_INVOICE_REJECT',
        reason: parsed.data.reason,
        afterData: {
          approvalStatus: updated.approvalStatus,
          approvalRejectedReason: updated.approvalRejectedReason,
          delegatedFromUserId: actor.delegatedFromUserId,
        },
      },
      tx,
    );

    return updated;
  });

  res.json({
    invoice: updatedInvoice,
  });
});

router.post('/invoices/:id/pay', requirePermissions(PERMISSIONS.PURCHASE_PAYMENTS_WRITE), async (req, res) => {
  const parsed = supplierPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru plata furnizor.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const invoiceId = String(req.params.id);
  const paymentDate = parsed.data.date ? new Date(parsed.data.date) : new Date();
  const paymentAmount = round2(parsed.data.amount);
  const paymentPeriod = currentPeriod(paymentDate);
  await assertPeriodOpen(companyId, paymentPeriod);

  const missingPaymentAccountsMessage = 'Conturi implicite lipsă pentru postarea automată a plății furnizor.';
  const overpaymentPrefix = 'Suma plătită depășește soldul deschis al facturii de furnizor.';
  let supplierName = '';

  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.supplierInvoice.findFirst({
      where: {
        id: invoiceId,
        companyId,
      },
      include: {
        payments: true,
        supplier: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!invoice) {
      throw HttpError.notFound('Factura de furnizor nu există.');
    }

    if (!openSupplierInvoiceStatuses.includes(invoice.status)) {
      throw HttpError.badRequest(
        `Factura de furnizor nu poate fi plătită în statusul "${invoice.status}". Statusuri permise: ${openSupplierInvoiceStatuses.join(', ')}.`,
      );
    }

    if (invoice.approvalStatus !== SupplierInvoiceApprovalStatus.APPROVED) {
      throw HttpError.badRequest(
        `Factura de furnizor nu poate fi plătită înainte de aprobarea completă. Status curent aprobare: ${invoice.approvalStatus}.`,
      );
    }

    const paidBefore = round2(invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
    const openAmount = round2(Math.max(toNumber(invoice.total) - paidBefore, 0));
    supplierName = invoice.supplier.name;

    if (paymentAmount > openAmount) {
      throw HttpError.badRequest(`${overpaymentPrefix} Sold disponibil: ${openAmount.toFixed(2)}.`);
    }

    let bankAccountId: string | null = null;
    let payableAccountId: string | null = null;

    if (parsed.data.autoPost) {
      const [bankAccount, payableAccount] = await Promise.all([
        tx.account.findFirst({
          where: {
            companyId,
            code: parsed.data.bankAccountCode,
          },
        }),
        tx.account.findFirst({
          where: {
            companyId,
            code: parsed.data.payableAccountCode,
          },
        }),
      ]);

      if (!bankAccount || !payableAccount) {
        throw HttpError.badRequest(missingPaymentAccountsMessage);
      }

      bankAccountId = bankAccount.id;
      payableAccountId = payableAccount.id;
    }

    const payment = await tx.supplierPayment.create({
      data: {
        companyId,
        supplierInvoiceId: invoice.id,
        supplierId: invoice.supplierId,
        date: paymentDate,
        amount: paymentAmount,
        method: parsed.data.method,
        reference: parsed.data.reference,
      },
    });

    const paidAfter = round2(paidBefore + paymentAmount);
    const invoiceTotal = toNumber(invoice.total);
    const nextStatus = paidAfter >= invoiceTotal ? SupplierInvoiceStatus.PAID : SupplierInvoiceStatus.PARTIALLY_PAID;

    const updatedInvoice = await tx.supplierInvoice.update({
      where: { id: invoice.id },
      data: {
        status: nextStatus,
      },
    });

    if (parsed.data.autoPost) {
      const journalNumber = await nextJournalEntryNumber(tx, companyId, paymentDate);
      await tx.journalEntry.create({
        data: {
          companyId,
          number: journalNumber,
          date: paymentDate,
          description: `Plată furnizor ${invoice.number}`,
          period: paymentPeriod,
          sourceModule: 'TREASURY',
          createdById: req.user!.id,
          lines: {
            create: [
              {
                accountId: payableAccountId!,
                debit: paymentAmount,
                credit: 0,
                explanation: `Stingere datorie ${invoice.number}`,
              },
              {
                accountId: bankAccountId!,
                debit: 0,
                credit: paymentAmount,
                explanation: `Plată ${invoice.number}`,
              },
            ],
          },
        },
      });
    }

    await writeAudit(
      req,
      {
        tableName: 'supplier_payments',
        recordId: payment.id,
        action: 'CREATE',
        reason: parsed.data.reason,
        afterData: {
          supplierInvoiceId: invoice.id,
          amount: payment.amount,
          method: payment.method,
        },
      },
      tx,
    );

    return { payment, invoice: updatedInvoice };
  });

  invalidateFinancialStatementsCache();
  void enqueueNotificationEvent({
    type: 'SUPPLIER_INVOICE_PAID',
    companyId,
    companyName: req.user!.companyName,
    triggeredByUserId: req.user!.id,
    payload: {
      supplierInvoiceId: result.invoice.id,
      number: result.invoice.number,
      supplierName,
      paidAmount: paymentAmount,
      currency: result.invoice.currency,
      status: result.invoice.status,
      paymentDate: paymentDate.toISOString(),
    },
  }).catch((error) => {
    logger.warn('notification_enqueue_failed', {
      eventType: 'SUPPLIER_INVOICE_PAID',
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  res.status(201).json(result);
});

router.get('/dashboard', requirePermissions(PERMISSIONS.PURCHASES_READ), async (req, res) => {
  const companyId = req.user!.companyId!;
  const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : new Date();

  if (Number.isNaN(asOf.getTime())) {
    res.status(400).json({ message: 'Parametrul asOf este invalid.' });
    return;
  }

  const topSuppliersQuery = req.query.topSuppliers ? Number(req.query.topSuppliers) : 5;
  if (!Number.isFinite(topSuppliersQuery) || !Number.isInteger(topSuppliersQuery) || topSuppliersQuery < 1) {
    res.status(400).json({ message: 'Parametrul topSuppliers trebuie să fie un număr întreg pozitiv.' });
    return;
  }

  const topSuppliersLimit = Math.min(topSuppliersQuery, 20);
  const asOfStart = new Date(asOf);
  asOfStart.setHours(0, 0, 0, 0);

  const next7DaysEnd = new Date(asOfStart);
  next7DaysEnd.setDate(next7DaysEnd.getDate() + 7);
  next7DaysEnd.setHours(23, 59, 59, 999);

  const invoices = await prisma.supplierInvoice.findMany({
    where: {
      companyId,
      status: {
        in: openSupplierInvoiceStatuses,
      },
    },
    include: {
      supplier: true,
      payments: true,
    },
    orderBy: [{ dueDate: 'asc' }, { receivedDate: 'asc' }],
  });

  let totalOpenAmount = 0;
  let overdueAmount = 0;
  let dueNext7DaysAmount = 0;
  let overdueInvoicesCount = 0;
  let openInvoicesCount = 0;

  const bySupplier = new Map<
    string,
    {
      supplierId: string;
      supplierName: string;
      openAmount: number;
      overdueAmount: number;
      invoicesCount: number;
      overdueInvoicesCount: number;
      earliestDueDate: Date;
    }
  >();

  for (const invoice of invoices) {
    const paid = round2(invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
    const openAmount = round2(Math.max(toNumber(invoice.total) - paid, 0));
    if (openAmount <= 0) {
      continue;
    }

    openInvoicesCount += 1;
    totalOpenAmount = round2(totalOpenAmount + openAmount);

    const isOverdue = invoice.dueDate < asOfStart;
    const isDueInNext7Days = invoice.dueDate >= asOfStart && invoice.dueDate <= next7DaysEnd;

    if (isOverdue) {
      overdueAmount = round2(overdueAmount + openAmount);
      overdueInvoicesCount += 1;
    } else if (isDueInNext7Days) {
      dueNext7DaysAmount = round2(dueNext7DaysAmount + openAmount);
    }

    const existingSupplierRow = bySupplier.get(invoice.supplierId);
    if (!existingSupplierRow) {
      bySupplier.set(invoice.supplierId, {
        supplierId: invoice.supplierId,
        supplierName: invoice.supplier.name,
        openAmount,
        overdueAmount: isOverdue ? openAmount : 0,
        invoicesCount: 1,
        overdueInvoicesCount: isOverdue ? 1 : 0,
        earliestDueDate: invoice.dueDate,
      });
      continue;
    }

    existingSupplierRow.openAmount = round2(existingSupplierRow.openAmount + openAmount);
    existingSupplierRow.invoicesCount += 1;
    if (isOverdue) {
      existingSupplierRow.overdueAmount = round2(existingSupplierRow.overdueAmount + openAmount);
      existingSupplierRow.overdueInvoicesCount += 1;
    }
    if (invoice.dueDate < existingSupplierRow.earliestDueDate) {
      existingSupplierRow.earliestDueDate = invoice.dueDate;
    }
  }

  const topSuppliers = Array.from(bySupplier.values())
    .sort((left, right) => {
      if (right.openAmount !== left.openAmount) {
        return right.openAmount - left.openAmount;
      }
      return left.supplierName.localeCompare(right.supplierName, 'ro');
    })
    .slice(0, topSuppliersLimit)
    .map((row) => ({
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      openAmount: row.openAmount,
      overdueAmount: row.overdueAmount,
      invoicesCount: row.invoicesCount,
      overdueInvoicesCount: row.overdueInvoicesCount,
      earliestDueDate: row.earliestDueDate,
    }));

  res.json({
    asOf: asOf.toISOString(),
    next7DaysUntil: next7DaysEnd.toISOString(),
    totals: {
      openAmount: totalOpenAmount,
      overdueAmount,
      dueNext7DaysAmount,
      openInvoicesCount,
      overdueInvoicesCount,
      topSuppliersCount: topSuppliers.length,
    },
    topSuppliers,
  });
});

router.get('/aging', requirePermissions(PERMISSIONS.PURCHASES_READ), async (req, res) => {
  const companyId = req.user!.companyId!;
  const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : new Date();

  if (Number.isNaN(asOf.getTime())) {
    res.status(400).json({ message: 'Parametrul asOf este invalid.' });
    return;
  }

  const invoices = await prisma.supplierInvoice.findMany({
    where: {
      companyId,
      status: {
        in: openSupplierInvoiceStatuses,
      },
    },
    include: {
      supplier: true,
      payments: true,
    },
    orderBy: [{ dueDate: 'asc' }, { receivedDate: 'asc' }],
  });

  const buckets = {
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
  };

  const rows = invoices.map((invoice) => {
    const paid = invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0);
    const openAmount = round2(Math.max(toNumber(invoice.total) - paid, 0));
    const diffDays = Math.floor((asOf.getTime() - invoice.dueDate.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays <= 0) {
      buckets.current = round2(buckets.current + openAmount);
    } else if (diffDays <= 30) {
      buckets.d1_30 = round2(buckets.d1_30 + openAmount);
    } else if (diffDays <= 60) {
      buckets.d31_60 = round2(buckets.d31_60 + openAmount);
    } else if (diffDays <= 90) {
      buckets.d61_90 = round2(buckets.d61_90 + openAmount);
    } else {
      buckets.d90_plus = round2(buckets.d90_plus + openAmount);
    }

    return {
      supplierInvoiceId: invoice.id,
      number: invoice.number,
      supplier: invoice.supplier.name,
      dueDate: invoice.dueDate,
      openAmount,
      overdueDays: Math.max(diffDays, 0),
      status: invoice.status,
    };
  });

  res.json({
    asOf: asOf.toISOString(),
    buckets,
    rows,
  });
});

export default router;
