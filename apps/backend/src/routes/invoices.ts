import type { Prisma } from '@prisma/client';
import { InvoiceKind, InvoiceStatus, PaymentMethod } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { invalidateFinancialStatementsCache } from '../lib/financial-statements-cache.js';
import { nextJournalEntryNumber } from '../lib/journal-entry-number.js';
import { parseListQuery, setPaginationHeaders } from '../lib/list-query.js';
import { logger } from '../lib/logger.js';
import { enqueueNotificationEvent } from '../lib/notification-queue.js';
import { assertPeriodOpen } from '../lib/period-lock.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions } from '../middleware/auth.js';
import { currentPeriod } from '../utils/accounting.js';
import { round2, toNumber } from '../utils/number.js';
import { writeAudit } from '../lib/audit.js';
import { HttpError } from '../lib/http-error.js';
import {
  buildEfacturaInvoiceXml,
  downloadSignedEfacturaXml,
  loadSignedEfacturaXml,
  persistSignedEfacturaXml,
  pollEfacturaStatus,
  submitEfacturaEndToEnd,
} from '../services/efactura/anaf-efactura-service.js';

const router = Router();

const createSchema = z.object({
  number: z.string().min(1),
  kind: z.enum(['PROFORMA', 'FISCAL', 'STORNO']).default('FISCAL'),
  stornoOfInvoiceId: z.string().min(1).optional(),
  partnerId: z.string().min(1).optional(),
  issueDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  currency: z.string().default('RON'),
  subtotal: z.coerce.number().positive().optional(),
  vat: z.coerce.number().min(0).optional(),
  description: z.string().optional(),
  autoPost: z.boolean().default(true),
  revenueAccountCode: z.string().default('707'),
  receivableAccountCode: z.string().default('4111'),
  vatAccountCode: z.string().default('4427'),
  reason: z.string().optional(),
});

const paymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(['BANK_TRANSFER', 'CASH', 'CARD', 'OTHER']).default('BANK_TRANSFER'),
  date: z.string().datetime().optional(),
  reference: z.string().optional(),
  autoPost: z.boolean().default(true),
  bankAccountCode: z.string().default('5121'),
  receivableAccountCode: z.string().default('4111'),
  reason: z.string().optional(),
});

const efacturaSendSchema = z.object({
  waitForSignedXml: z.boolean().default(true),
  reason: z.string().max(300).optional(),
});

const efacturaPollSchema = z.object({
  downloadSignedXml: z.boolean().default(true),
  reason: z.string().max(300).optional(),
});

const invoiceSortFields = ['issueDate', 'dueDate', 'number', 'total', 'status', 'createdAt', 'partnerName'] as const;
type InvoiceSortField = (typeof invoiceSortFields)[number];
const invoiceStatusValues = new Set<InvoiceStatus>(Object.values(InvoiceStatus));
const openInvoiceStatuses: InvoiceStatus[] = [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID];
type InvoiceListResult = Awaited<ReturnType<typeof prisma.invoice.findMany>>;
type InvoiceListQuery = ReturnType<typeof parseListQuery<InvoiceSortField>>;
const INVOICE_LIST_CACHE_TTL_MS = Math.max(1000, env.REPORTS_CACHE_TTL_MS);
const invoiceListCache = new Map<string, { invoices: InvoiceListResult; totalCount: number; expiresAt: number }>();
const invoiceListInFlight = new Map<string, Promise<{ invoices: InvoiceListResult; totalCount: number }>>();

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === undefined) {
    return {};
  }

  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    return {};
  }

  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function storageErrorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Eroare necunoscută la persistarea XML-ului semnat.';
}

function appendStorageWarning(baseMessage: string | null, storageError: string | null): string | null {
  if (!storageError) {
    return baseMessage;
  }

  const warning = `XML-ul semnat nu a putut fi arhivat în object storage: ${storageError}`;
  return baseMessage ? `${baseMessage} | ${warning}` : warning;
}

function cleanupInvoiceListCache(now = Date.now()): void {
  for (const [key, cached] of invoiceListCache.entries()) {
    if (cached.expiresAt <= now) {
      invoiceListCache.delete(key);
    }
  }
}

function buildInvoiceListCacheKey(companyId: string, query: InvoiceListQuery): string {
  return [
    companyId,
    query.search ?? '',
    query.sortField,
    query.sortDirection,
    query.paginationEnabled ? '1' : '0',
    String(query.page),
    String(query.pageSize),
  ].join('|');
}

function invalidateInvoiceListCache(): void {
  invoiceListCache.clear();
  invoiceListInFlight.clear();
}

function buildInvoiceOrderBy(
  sortField: InvoiceSortField,
  sortDirection: Prisma.SortOrder,
): Prisma.InvoiceOrderByWithRelationInput[] {
  switch (sortField) {
    case 'dueDate':
      return [{ dueDate: sortDirection }, { issueDate: 'desc' }, { id: 'desc' }];
    case 'number':
      return [{ number: sortDirection }, { issueDate: 'desc' }, { id: 'desc' }];
    case 'total':
      return [{ total: sortDirection }, { issueDate: 'desc' }, { id: 'desc' }];
    case 'status':
      return [{ status: sortDirection }, { issueDate: 'desc' }, { id: 'desc' }];
    case 'createdAt':
      return [{ createdAt: sortDirection }, { issueDate: 'desc' }, { id: 'desc' }];
    case 'partnerName':
      return [{ partner: { name: sortDirection } }, { issueDate: 'desc' }, { id: 'desc' }];
    case 'issueDate':
    default:
      return [{ issueDate: sortDirection }, { id: 'desc' }];
  }
}

router.get('/', requirePermissions(PERMISSIONS.INVOICES_READ), async (req, res) => {
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: invoiceSortFields,
    defaultSortField: 'issueDate',
    defaultSortDirection: 'desc',
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  const searchedStatus = query.search?.toUpperCase();
  const whereOrConditions: Prisma.InvoiceWhereInput[] = query.search
    ? [
        { number: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { partner: { name: { contains: query.search, mode: 'insensitive' } } },
        { partner: { cui: { contains: query.search, mode: 'insensitive' } } },
      ]
    : [];

  if (searchedStatus && invoiceStatusValues.has(searchedStatus as InvoiceStatus)) {
    whereOrConditions.push({ status: searchedStatus as InvoiceStatus });
  }

  const baseWhere: Prisma.InvoiceWhereInput = {
    companyId: req.user!.companyId!,
  };

  const searchWhere: Prisma.InvoiceWhereInput | undefined =
    whereOrConditions.length > 0
      ? {
          OR: whereOrConditions,
        }
      : undefined;

  const where: Prisma.InvoiceWhereInput = searchWhere
    ? {
        AND: [baseWhere, searchWhere],
      }
    : baseWhere;

  const orderBy = buildInvoiceOrderBy(query.sortField, query.sortDirection);
  const cacheKey = buildInvoiceListCacheKey(req.user!.companyId!, query);
  const now = Date.now();
  cleanupInvoiceListCache(now);

  const cached = invoiceListCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if (query.paginationEnabled) {
      setPaginationHeaders(res, {
        totalCount: cached.totalCount,
        page: query.page,
        pageSize: query.pageSize,
      });
    }
    res.json(cached.invoices);
    return;
  }

  const cachedInFlight = invoiceListInFlight.get(cacheKey);
  if (cachedInFlight) {
    const { invoices, totalCount } = await cachedInFlight;
    if (query.paginationEnabled) {
      setPaginationHeaders(res, {
        totalCount,
        page: query.page,
        pageSize: query.pageSize,
      });
    }
    res.json(invoices);
    return;
  }

  const fetchPromise = (async (): Promise<{ invoices: InvoiceListResult; totalCount: number }> => {
    const invoicesPromise = prisma.invoice.findMany({
      where,
      include: {
        partner: {
          select: {
            id: true,
            name: true,
            cui: true,
            iban: true,
            type: true,
            email: true,
            phone: true,
          },
        },
        payments: {
          select: {
            id: true,
            amount: true,
            method: true,
            date: true,
            reference: true,
          },
        },
      },
      orderBy,
      skip: query.skip,
      take: query.take,
    });

    if (!query.paginationEnabled) {
      return {
        invoices: await invoicesPromise,
        totalCount: 0,
      };
    }

    const [invoices, totalCount] = await Promise.all([invoicesPromise, prisma.invoice.count({ where })]);
    return {
      invoices,
      totalCount,
    };
  })()
    .then((result) => {
      invoiceListCache.set(cacheKey, {
        ...result,
        expiresAt: Date.now() + INVOICE_LIST_CACHE_TTL_MS,
      });
      return result;
    })
    .finally(() => {
      invoiceListInFlight.delete(cacheKey);
    });

  invoiceListInFlight.set(cacheKey, fetchPromise);
  const { invoices, totalCount } = await fetchPromise;

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(invoices);
});

router.post('/', requirePermissions(PERMISSIONS.INVOICES_WRITE), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru factură.' });
    return;
  }

  const kind = parsed.data.kind as InvoiceKind;
  const issueDate = parsed.data.issueDate ? new Date(parsed.data.issueDate) : new Date();
  const isStorno = kind === InvoiceKind.STORNO;
  const isProforma = kind === InvoiceKind.PROFORMA;

  if (isStorno && !parsed.data.stornoOfInvoiceId) {
    res.status(400).json({ message: 'Factura STORNO trebuie să indice factura sursă (stornoOfInvoiceId).' });
    return;
  }

  if (!isStorno && parsed.data.stornoOfInvoiceId) {
    res.status(400).json({ message: 'Câmpul stornoOfInvoiceId este permis doar pentru facturile de tip STORNO.' });
    return;
  }

  if (!isStorno) {
    const missingFields =
      !parsed.data.partnerId ||
      !parsed.data.dueDate ||
      parsed.data.subtotal === undefined ||
      parsed.data.vat === undefined;
    if (missingFields) {
      res.status(400).json({ message: 'Facturile FISCAL/PROFORMA necesită partnerId, dueDate, subtotal și vat.' });
      return;
    }

    const dueDate = new Date(parsed.data.dueDate!);
    if (dueDate.getTime() < issueDate.getTime()) {
      res.status(400).json({ message: 'Data scadenței trebuie să fie mai mare sau egală cu data emiterii.' });
      return;
    }
  }

  const shouldAutoPost = parsed.data.autoPost && !isProforma;
  const issuePeriod = currentPeriod(issueDate);
  await assertPeriodOpen(req.user!.companyId!, issuePeriod);
  const missingAccountsMessage = 'Conturi implicite lipsă pentru postarea automată a facturii.';

  const invoice = await prisma.$transaction(async (tx) => {
    let stornoSourceInvoice:
      | {
          id: string;
          number: string;
          kind: InvoiceKind;
          status: InvoiceStatus;
          partnerId: string;
          subtotal: Prisma.Decimal;
          vat: Prisma.Decimal;
        }
      | null = null;
    let partnerId: string;
    let dueDate: Date;
    let subtotal: number;
    let vat: number;
    let total: number;
    let description = parsed.data.description;

    if (isStorno) {
      stornoSourceInvoice = await tx.invoice.findFirst({
        where: {
          id: parsed.data.stornoOfInvoiceId!,
          companyId: req.user!.companyId!,
        },
        select: {
          id: true,
          number: true,
          kind: true,
          status: true,
          partnerId: true,
          subtotal: true,
          vat: true,
        },
      });

      if (!stornoSourceInvoice) {
        throw HttpError.badRequest('Factura sursă pentru STORNO nu există în compania activă.');
      }

      if (stornoSourceInvoice.kind !== InvoiceKind.FISCAL) {
        throw HttpError.badRequest('Se poate face STORNO doar pentru facturi de tip FISCAL.');
      }

      if (stornoSourceInvoice.status === InvoiceStatus.CANCELLED) {
        throw HttpError.badRequest('Factura sursă este anulată și nu poate fi stornată.');
      }

      partnerId = stornoSourceInvoice.partnerId;
      dueDate = issueDate;
      subtotal = round2(-Math.abs(toNumber(stornoSourceInvoice.subtotal)));
      vat = round2(-Math.abs(toNumber(stornoSourceInvoice.vat)));
      total = round2(subtotal + vat);
      description = parsed.data.description ?? `Storno factura ${stornoSourceInvoice.number}`;
    } else {
      const partner = await tx.partner.findFirst({
        where: {
          id: parsed.data.partnerId!,
          companyId: req.user!.companyId!,
        },
        select: { id: true },
      });

      if (!partner) {
        throw HttpError.badRequest('Partener inexistent în compania activă.');
      }

      partnerId = parsed.data.partnerId!;
      dueDate = new Date(parsed.data.dueDate!);
      subtotal = round2(parsed.data.subtotal!);
      vat = round2(parsed.data.vat!);
      total = round2(subtotal + vat);
    }

    let receivableAccountId: string | null = null;
    let revenueAccountId: string | null = null;
    let vatAccountId: string | null = null;

    if (shouldAutoPost) {
      const [receivableAccount, revenueAccount, vatAccount] = await Promise.all([
        tx.account.findFirst({
          where: {
            companyId: req.user!.companyId!,
            code: parsed.data.receivableAccountCode,
          },
        }),
        tx.account.findFirst({
          where: {
            companyId: req.user!.companyId!,
            code: parsed.data.revenueAccountCode,
          },
        }),
        tx.account.findFirst({
          where: {
            companyId: req.user!.companyId!,
            code: parsed.data.vatAccountCode,
          },
        }),
      ]);

      if (!receivableAccount || !revenueAccount || !vatAccount) {
        throw HttpError.badRequest(missingAccountsMessage);
      }

      receivableAccountId = receivableAccount.id;
      revenueAccountId = revenueAccount.id;
      vatAccountId = vatAccount.id;
    }

    const createdInvoice = await tx.invoice.create({
      data: {
        companyId: req.user!.companyId!,
        number: parsed.data.number,
        kind,
        stornoOfInvoiceId: stornoSourceInvoice?.id,
        partnerId,
        issueDate,
        dueDate,
        currency: parsed.data.currency,
        subtotal,
        vat,
        total,
        status: isProforma ? InvoiceStatus.DRAFT : InvoiceStatus.ISSUED,
        description,
      },
      include: {
        partner: true,
        payments: true,
      },
    });

    if (shouldAutoPost) {
      const journalNumber = await nextJournalEntryNumber(tx, req.user!.companyId!, issueDate);
      const stornoAbsSubtotal = round2(Math.abs(subtotal));
      const stornoAbsVat = round2(Math.abs(vat));
      const stornoAbsTotal = round2(Math.abs(total));
      const journalLines =
        kind === InvoiceKind.STORNO
          ? [
              {
                accountId: receivableAccountId!,
                debit: 0,
                credit: stornoAbsTotal,
                explanation: `Storno creanță ${createdInvoice.number}`,
              },
              {
                accountId: revenueAccountId!,
                debit: stornoAbsSubtotal,
                credit: 0,
                explanation: `Storno venit ${createdInvoice.number}`,
              },
              {
                accountId: vatAccountId!,
                debit: stornoAbsVat,
                credit: 0,
                explanation: `Storno TVA ${createdInvoice.number}`,
              },
            ]
          : [
              {
                accountId: receivableAccountId!,
                debit: total,
                credit: 0,
                explanation: `Factura ${createdInvoice.number}`,
              },
              {
                accountId: revenueAccountId!,
                debit: 0,
                credit: subtotal,
                explanation: `Venit factura ${createdInvoice.number}`,
              },
              {
                accountId: vatAccountId!,
                debit: 0,
                credit: vat,
                explanation: `TVA colectată factura ${createdInvoice.number}`,
              },
            ];

      await tx.journalEntry.create({
        data: {
          companyId: req.user!.companyId!,
          number: journalNumber,
          date: issueDate,
          description:
            kind === InvoiceKind.STORNO
              ? `Postare automată storno ${createdInvoice.number}`
              : `Postare automată factură ${createdInvoice.number}`,
          period: issuePeriod,
          sourceModule: 'ACCOUNTS_RECEIVABLE',
          createdById: req.user!.id,
          lines: {
            create: journalLines,
          },
        },
      });
    }

    await writeAudit(
      req,
      {
        tableName: 'invoices',
        recordId: createdInvoice.id,
        action: 'CREATE',
        reason: parsed.data.reason,
        afterData: {
          number: createdInvoice.number,
          kind: createdInvoice.kind,
          stornoOfInvoiceId: createdInvoice.stornoOfInvoiceId,
          total: createdInvoice.total,
          status: createdInvoice.status,
        },
      },
      tx,
    );

    return createdInvoice;
  });

  invalidateFinancialStatementsCache();
  invalidateInvoiceListCache();
  void enqueueNotificationEvent({
    type: 'INVOICE_CREATED',
    companyId: req.user!.companyId!,
    companyName: req.user!.companyName,
    triggeredByUserId: req.user!.id,
    payload: {
      invoiceId: invoice.id,
      number: invoice.number,
      partnerName: invoice.partner.name,
      total: toNumber(invoice.total),
      currency: invoice.currency,
      issueDate: invoice.issueDate.toISOString(),
      dueDate: invoice.dueDate.toISOString(),
    },
  }).catch((error) => {
    logger.warn('notification_enqueue_failed', {
      eventType: 'INVOICE_CREATED',
      companyId: req.user!.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  res.status(201).json(invoice);
});

router.post('/:id/pay', requirePermissions(PERMISSIONS.PAYMENTS_WRITE), async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru plată.' });
    return;
  }

  const invoiceId = String(req.params.id);
  const paymentDate = parsed.data.date ? new Date(parsed.data.date) : new Date();
  const paymentAmount = round2(parsed.data.amount);
  const paymentPeriod = currentPeriod(paymentDate);
  await assertPeriodOpen(req.user!.companyId!, paymentPeriod);
  const missingPaymentAccountsMessage = 'Conturi implicite lipsă pentru postarea automată a plății.';
  const overpaymentPrefix = 'Suma încasată depășește soldul deschis al facturii.';
  let partnerName = '';

  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: {
        id: invoiceId,
        companyId: req.user!.companyId!,
      },
      include: {
        payments: true,
        partner: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!invoice) {
      throw HttpError.notFound('Factura nu există.');
    }

    if (invoice.kind !== InvoiceKind.FISCAL) {
      throw HttpError.badRequest(
        `Încasarea este permisă doar pentru facturile de tip FISCAL. Tip curent: ${invoice.kind}.`,
      );
    }

    if (!openInvoiceStatuses.includes(invoice.status)) {
      throw HttpError.badRequest(
        `Factura nu poate fi încasată în statusul "${invoice.status}". Statusuri permise: ${openInvoiceStatuses.join(', ')}.`,
      );
    }

    const paidBefore = round2(invoice.payments.reduce((acc, item) => acc + toNumber(item.amount), 0));
    const invoiceTotal = toNumber(invoice.total);
    const openAmount = round2(Math.max(invoiceTotal - paidBefore, 0));
    partnerName = invoice.partner.name;

    if (paymentAmount > openAmount) {
      throw HttpError.badRequest(`${overpaymentPrefix} Sold disponibil: ${openAmount.toFixed(2)}.`);
    }

    let bankAccountId: string | null = null;
    let receivableAccountId: string | null = null;

    if (parsed.data.autoPost) {
      const [bankAccount, receivableAccount] = await Promise.all([
        tx.account.findFirst({
          where: {
            companyId: req.user!.companyId!,
            code: parsed.data.bankAccountCode,
          },
        }),
        tx.account.findFirst({
          where: {
            companyId: req.user!.companyId!,
            code: parsed.data.receivableAccountCode,
          },
        }),
      ]);

      if (!bankAccount || !receivableAccount) {
        throw HttpError.badRequest(missingPaymentAccountsMessage);
      }

      bankAccountId = bankAccount.id;
      receivableAccountId = receivableAccount.id;
    }

    const payment = await tx.payment.create({
      data: {
        companyId: req.user!.companyId!,
        invoiceId: invoice.id,
        partnerId: invoice.partnerId,
        date: paymentDate,
        amount: paymentAmount,
        method: parsed.data.method as PaymentMethod,
        reference: parsed.data.reference,
      },
    });

    const paidAfter = round2(paidBefore + paymentAmount);
    const nextStatus = paidAfter >= invoiceTotal ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID;

    const updatedInvoice = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: nextStatus },
    });

    if (parsed.data.autoPost) {
      const journalNumber = await nextJournalEntryNumber(tx, req.user!.companyId!, paymentDate);
      await tx.journalEntry.create({
        data: {
          companyId: req.user!.companyId!,
          number: journalNumber,
          date: paymentDate,
          description: `Încasare factură ${invoice.number}`,
          period: paymentPeriod,
          sourceModule: 'TREASURY',
          createdById: req.user!.id,
          lines: {
            create: [
              {
                accountId: bankAccountId!,
                debit: paymentAmount,
                credit: 0,
                explanation: `Încasare ${invoice.number}`,
              },
              {
                accountId: receivableAccountId!,
                debit: 0,
                credit: paymentAmount,
                explanation: `Stingere ${invoice.number}`,
              },
            ],
          },
        },
      });
    }

    await writeAudit(
      req,
      {
        tableName: 'payments',
        recordId: payment.id,
        action: 'CREATE',
        reason: parsed.data.reason,
        afterData: {
          invoiceId: invoice.id,
          amount: payment.amount,
          method: payment.method,
        },
      },
      tx,
    );

    return { payment, invoice: updatedInvoice };
  });

  invalidateFinancialStatementsCache();
  invalidateInvoiceListCache();
  void enqueueNotificationEvent({
    type: 'INVOICE_PAID',
    companyId: req.user!.companyId!,
    companyName: req.user!.companyName,
    triggeredByUserId: req.user!.id,
    payload: {
      invoiceId: result.invoice.id,
      number: result.invoice.number,
      partnerName,
      paidAmount: paymentAmount,
      currency: result.invoice.currency,
      status: result.invoice.status,
      paymentDate: paymentDate.toISOString(),
    },
  }).catch((error) => {
    logger.warn('notification_enqueue_failed', {
      eventType: 'INVOICE_PAID',
      companyId: req.user!.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  res.status(201).json(result);
});

router.post('/:id/efactura/send', requirePermissions(PERMISSIONS.INVOICES_WRITE), async (req, res) => {
  if (env.ANAF_EFACTURA_MODE === 'off') {
    throw HttpError.conflict('Integrarea e-Factura este dezactivată (ANAF_EFACTURA_MODE=off).');
  }

  const parsed = efacturaSendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru trimiterea e-Factura.' });
    return;
  }

  const invoiceId = String(req.params.id);
  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      companyId: req.user!.companyId!,
    },
    include: {
      partner: {
        select: {
          id: true,
          name: true,
          cui: true,
          iban: true,
        },
      },
      company: {
        select: {
          id: true,
          name: true,
          cui: true,
        },
      },
      payments: true,
    },
  });

  if (!invoice) {
    throw HttpError.notFound('Factura nu există.');
  }

  if (invoice.kind !== 'FISCAL') {
    throw HttpError.conflict('Doar facturile fiscale pot fi transmise în RO e-Factura.');
  }

  if (invoice.status === InvoiceStatus.CANCELLED) {
    throw HttpError.conflict('Facturile anulate nu pot fi transmise în RO e-Factura.');
  }

  if (!invoice.partner.cui) {
    throw HttpError.badRequest('Factura nu poate fi transmisă: partenerul nu are CUI configurat.');
  }

  const supplierCui = invoice.company?.cui ?? env.ANAF_COMPANY_CUI;
  const xml = buildEfacturaInvoiceXml(
    {
      invoiceId: invoice.id,
      number: invoice.number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      subtotal: toNumber(invoice.subtotal),
      vat: toNumber(invoice.vat),
      total: toNumber(invoice.total),
      description: invoice.description,
    },
    {
      companyId: req.user!.companyId!,
      name: invoice.company?.name ?? env.ANAF_COMPANY_NAME,
      cui: supplierCui,
      address: env.ANAF_COMPANY_ADDRESS,
      iban: null,
    },
    {
      name: invoice.partner.name,
      cui: invoice.partner.cui,
      iban: invoice.partner.iban,
      address: null,
    },
  );

  const submission = await submitEfacturaEndToEnd({
    xml,
    waitForSignedXml: parsed.data.waitForSignedXml,
  });

  let signedXmlPath = invoice.efacturaSignedXmlPath;
  let signedXmlStorageError: string | null = null;
  if (submission.signedXml) {
    try {
      signedXmlPath = await persistSignedEfacturaXml(req.user!.companyId!, invoice.id, submission.signedXml);
    } catch (error) {
      signedXmlStorageError = storageErrorMessage(error);
    }
  }

  const resolvedMessage = appendStorageWarning(submission.message, signedXmlStorageError);

  const now = new Date();
  const updatedInvoice = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      efacturaStatus: submission.status,
      efacturaUploadIndex: submission.uploadIndex,
      efacturaDownloadId: submission.downloadId,
      efacturaMessage: resolvedMessage,
      efacturaSignedXmlPath: signedXmlPath,
      efacturaSubmittedAt: invoice.efacturaSubmittedAt ?? now,
      efacturaAcceptedAt: submission.status === 'ACCEPTED' ? now : invoice.efacturaAcceptedAt,
      efacturaLastSyncAt: now,
      efacturaRawStatus: toJsonValue(submission.raw),
    },
    include: {
      partner: true,
      payments: true,
    },
  });

  await writeAudit(req, {
    tableName: 'invoices',
    recordId: invoice.id,
    action: 'EFACTURA_SUBMIT',
    reason: parsed.data.reason,
    afterData: {
      uploadIndex: submission.uploadIndex,
      status: submission.status,
      downloadId: submission.downloadId,
      polls: submission.polls,
      signedXmlStorageError,
    },
  });

  res.json({
    invoice: updatedInvoice,
    efactura: {
      uploadIndex: submission.uploadIndex,
      status: submission.status,
      message: resolvedMessage,
      downloadId: submission.downloadId,
      polls: submission.polls,
      signedXmlAvailable: Boolean(signedXmlPath),
      signedXmlStorageError,
    },
  });
  invalidateInvoiceListCache();
});

router.post('/:id/efactura/poll', requirePermissions(PERMISSIONS.INVOICES_WRITE), async (req, res) => {
  if (env.ANAF_EFACTURA_MODE === 'off') {
    throw HttpError.conflict('Integrarea e-Factura este dezactivată (ANAF_EFACTURA_MODE=off).');
  }

  const parsed = efacturaPollSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru verificarea statusului e-Factura.' });
    return;
  }

  const invoiceId = String(req.params.id);
  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      companyId: req.user!.companyId!,
    },
    include: {
      partner: true,
      payments: true,
    },
  });

  if (!invoice) {
    throw HttpError.notFound('Factura nu există.');
  }

  if (!invoice.efacturaUploadIndex) {
    throw HttpError.conflict('Factura nu are index de încărcare ANAF. Rulează mai întâi send.');
  }

  const snapshot = await pollEfacturaStatus(invoice.efacturaUploadIndex);
  let signedXmlPath = invoice.efacturaSignedXmlPath;
  let signedXmlDownloaded = false;
  let signedXmlStorageError: string | null = null;
  let rawStatus = snapshot.raw;
  const resolvedDownloadId = snapshot.downloadId ?? invoice.efacturaDownloadId;

  if (parsed.data.downloadSignedXml && snapshot.status === 'ACCEPTED' && resolvedDownloadId && !signedXmlPath) {
    const downloaded = await downloadSignedEfacturaXml(resolvedDownloadId);
    rawStatus = downloaded.raw;
    try {
      signedXmlPath = await persistSignedEfacturaXml(req.user!.companyId!, invoice.id, downloaded.xml);
      signedXmlDownloaded = true;
    } catch (error) {
      signedXmlStorageError = storageErrorMessage(error);
    }
  }

  const resolvedMessage = appendStorageWarning(snapshot.message, signedXmlStorageError);

  const now = new Date();
  const updatedInvoice = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      efacturaStatus: snapshot.status,
      efacturaDownloadId: resolvedDownloadId,
      efacturaMessage: resolvedMessage,
      efacturaSignedXmlPath: signedXmlPath,
      efacturaAcceptedAt: snapshot.status === 'ACCEPTED' ? (invoice.efacturaAcceptedAt ?? now) : invoice.efacturaAcceptedAt,
      efacturaLastSyncAt: now,
      efacturaRawStatus: toJsonValue(rawStatus),
    },
    include: {
      partner: true,
      payments: true,
    },
  });

  await writeAudit(req, {
    tableName: 'invoices',
    recordId: invoice.id,
    action: 'EFACTURA_POLL',
    reason: parsed.data.reason,
    afterData: {
      uploadIndex: invoice.efacturaUploadIndex,
      status: snapshot.status,
      downloadId: resolvedDownloadId,
      signedXmlDownloaded,
      signedXmlStorageError,
    },
  });

  res.json({
    invoice: updatedInvoice,
    efactura: {
      uploadIndex: invoice.efacturaUploadIndex,
      status: snapshot.status,
      message: resolvedMessage,
      downloadId: resolvedDownloadId,
      signedXmlAvailable: Boolean(signedXmlPath),
      signedXmlDownloaded,
      signedXmlStorageError,
    },
  });
  invalidateInvoiceListCache();
});

router.get('/:id/efactura/signed-xml', requirePermissions(PERMISSIONS.INVOICES_READ), async (req, res) => {
  const invoiceId = String(req.params.id);
  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      companyId: req.user!.companyId!,
    },
    select: {
      id: true,
      number: true,
      efacturaSignedXmlPath: true,
    },
  });

  if (!invoice) {
    throw HttpError.notFound('Factura nu există.');
  }

  if (!invoice.efacturaSignedXmlPath) {
    throw HttpError.notFound('XML-ul semnat ANAF nu este disponibil pentru această factură.');
  }

  const xml = await loadSignedEfacturaXml(invoice.efacturaSignedXmlPath);
  const safeNumber = invoice.number.replace(/[^A-Za-z0-9._-]/g, '_');

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="efactura-${safeNumber}-signed.xml"`);
  res.send(xml);
});

export default router;
