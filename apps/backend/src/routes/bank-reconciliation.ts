import type { Prisma } from '@prisma/client';
import {
  BankStatementLineStatus,
  InvoiceStatus,
  PaymentMethod,
  SupplierInvoiceStatus,
} from '@prisma/client';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { parseBankStatementFile } from '../lib/bank-statement-file-parser.js';
import { invalidateFinancialStatementsCache } from '../lib/financial-statements-cache.js';
import { HttpError } from '../lib/http-error.js';
import { nextJournalEntryNumber } from '../lib/journal-entry-number.js';
import { parseListQuery, setPaginationHeaders } from '../lib/list-query.js';
import { assertPeriodOpen } from '../lib/period-lock.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions } from '../middleware/auth.js';
import { currentPeriod } from '../utils/accounting.js';
import { round2, toNumber } from '../utils/number.js';

const router = Router();
const statementFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 8 * 1024 * 1024,
  },
});

const importStatementSchema = z.object({
  accountCode: z.string().min(1),
  statementDate: z.string().datetime(),
  currency: z.string().default('RON'),
  openingBalance: z.coerce.number().optional(),
  closingBalance: z.coerce.number().optional(),
  sourceLabel: z.string().optional(),
  reason: z.string().optional(),
  lines: z
    .array(
      z.object({
        date: z.string().datetime(),
        amount: z.coerce.number().refine((value) => value !== 0, {
          message: 'Valoarea amount nu poate fi 0.',
        }),
        description: z.string().optional(),
        reference: z.string().optional(),
        counterpartyName: z.string().optional(),
        counterpartyIban: z.string().optional(),
      }),
    )
    .min(1)
    .max(5000),
});

function emptyStringToUndefined(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const importStatementFileSchema = z.object({
  accountCode: z.string().trim().min(1),
  format: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
      z.enum(['AUTO', 'MT940', 'CAMT053', 'CSV']).default('AUTO'),
    ),
  statementDate: z.preprocess(emptyStringToUndefined, z.string().datetime().optional()),
  currency: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return value;
      }
      const trimmed = value.trim().toUpperCase();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    z.string().length(3).optional(),
  ),
  sourceLabel: z.preprocess(emptyStringToUndefined, z.string().max(120).optional()),
  reason: z.preprocess(emptyStringToUndefined, z.string().optional()),
  csvDelimiter: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return value;
      }
      return value.length > 0 ? value[0] : undefined;
    },
    z.string().length(1).optional(),
  ),
  encoding: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.enum(['utf8', 'latin1']).default('utf8'),
  ),
});

const reconcileLineSchema = z.object({
  targetType: z.enum(['INVOICE', 'SUPPLIER_INVOICE']),
  targetId: z.string().min(1),
  method: z.enum(['BANK_TRANSFER', 'CASH', 'CARD', 'OTHER']).default('BANK_TRANSFER'),
  reference: z.string().optional(),
  autoPost: z.boolean().default(true),
  bankAccountCode: z.string().default('5121'),
  receivableAccountCode: z.string().default('4111'),
  payableAccountCode: z.string().default('401'),
  reason: z.string().optional(),
});

const ignoreLineSchema = z.object({
  reason: z.string().optional(),
});

const statementSortFields = ['statementDate', 'importedAt', 'accountCode', 'createdAt'] as const;
const lineSortFields = ['date', 'amount', 'status', 'createdAt'] as const;
const lineStatuses = new Set<BankStatementLineStatus>(Object.values(BankStatementLineStatus));

function buildStatementOrderBy(
  sortField: (typeof statementSortFields)[number],
  sortDirection: Prisma.SortOrder,
): Prisma.BankStatementOrderByWithRelationInput[] {
  switch (sortField) {
    case 'importedAt':
      return [{ importedAt: sortDirection }, { id: 'desc' }];
    case 'accountCode':
      return [{ accountCode: sortDirection }, { statementDate: 'desc' }, { id: 'desc' }];
    case 'createdAt':
      return [{ createdAt: sortDirection }, { id: 'desc' }];
    case 'statementDate':
    default:
      return [{ statementDate: sortDirection }, { id: 'desc' }];
  }
}

function buildLineOrderBy(
  sortField: (typeof lineSortFields)[number],
  sortDirection: Prisma.SortOrder,
): Prisma.BankStatementLineOrderByWithRelationInput[] {
  switch (sortField) {
    case 'amount':
      return [{ amount: sortDirection }, { date: 'desc' }, { id: 'desc' }];
    case 'status':
      return [{ status: sortDirection }, { date: 'desc' }, { id: 'desc' }];
    case 'createdAt':
      return [{ createdAt: sortDirection }, { id: 'desc' }];
    case 'date':
    default:
      return [{ date: sortDirection }, { id: 'desc' }];
  }
}

function scoreSuggestion({
  expectedAmount,
  openAmount,
  lineReference,
  candidateNumber,
  lineDescription,
  candidatePartnerName,
}: {
  expectedAmount: number;
  openAmount: number;
  lineReference?: string | null;
  candidateNumber: string;
  lineDescription?: string | null;
  candidatePartnerName: string;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const diff = Math.abs(expectedAmount - openAmount);
  let score = Math.max(0, 100 - diff);

  if (lineReference && lineReference.toLowerCase().includes(candidateNumber.toLowerCase())) {
    score += 40;
    reasons.push('Referința conține numărul documentului.');
  }

  if (lineDescription && lineDescription.toLowerCase().includes(candidatePartnerName.toLowerCase())) {
    score += 15;
    reasons.push('Descrierea conține numele partenerului.');
  }

  if (diff <= 0.01) {
    score += 30;
    reasons.push('Suma se potrivește exact.');
  } else if (diff <= 5) {
    score += 10;
    reasons.push('Suma este apropiată.');
  }

  return { score, reasons };
}

async function importBankStatement({
  req,
  payload,
}: {
  req: Parameters<typeof writeAudit>[0];
  payload: z.infer<typeof importStatementSchema>;
}) {
  const companyId = req.user!.companyId!;

  return prisma.$transaction(async (tx) => {
    const bankAccount = await tx.account.findFirst({
      where: {
        companyId,
        code: payload.accountCode,
      },
      select: { id: true },
    });

    if (!bankAccount) {
      throw HttpError.badRequest('Contul bancar specificat nu există în compania activă.');
    }

    const createdStatement = await tx.bankStatement.create({
      data: {
        companyId,
        accountCode: payload.accountCode,
        statementDate: new Date(payload.statementDate),
        currency: payload.currency,
        openingBalance: payload.openingBalance,
        closingBalance: payload.closingBalance,
        sourceLabel: payload.sourceLabel,
        uploadedById: req.user!.id,
      },
    });

    await tx.bankStatementLine.createMany({
      data: payload.lines.map((line) => ({
        companyId,
        statementId: createdStatement.id,
        date: new Date(line.date),
        amount: round2(line.amount),
        description: line.description,
        reference: line.reference,
        counterpartyName: line.counterpartyName,
        counterpartyIban: line.counterpartyIban,
      })),
    });

    await writeAudit(
      req,
      {
        tableName: 'bank_statements',
        recordId: createdStatement.id,
        action: 'CREATE',
        reason: payload.reason,
        afterData: {
          accountCode: createdStatement.accountCode,
          statementDate: createdStatement.statementDate,
          linesImported: payload.lines.length,
        },
      },
      tx,
    );

    return createdStatement;
  });
}

router.post('/statements/import', requirePermissions(PERMISSIONS.BANK_RECONCILIATION_WRITE), async (req, res) => {
  const parsed = importStatementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru import extras bancar.' });
    return;
  }

  const statement = await importBankStatement({
    req,
    payload: parsed.data,
  });

  res.status(201).json(statement);
});

router.post(
  '/statements/import-file',
  requirePermissions(PERMISSIONS.BANK_RECONCILIATION_WRITE),
  statementFileUpload.single('file'),
  async (req, res) => {
    if (!req.file) {
      res.status(400).json({ message: 'Fișierul de extras este obligatoriu (field: file).' });
      return;
    }

    const parsedMetadata = importStatementFileSchema.safeParse(req.body);
    if (!parsedMetadata.success) {
      res.status(400).json({ message: 'Date invalide pentru import extras din fișier.' });
      return;
    }

    let parsedFile;
    try {
      parsedFile = parseBankStatementFile({
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        content: req.file.buffer.toString(parsedMetadata.data.encoding),
        format: parsedMetadata.data.format,
        csvDelimiter: parsedMetadata.data.csvDelimiter,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Fișier extras invalid.';
      res.status(400).json({
        message: `Import extras eșuat: ${message}`,
      });
      return;
    }

    const payload = importStatementSchema.safeParse({
      accountCode: parsedMetadata.data.accountCode,
      statementDate: parsedMetadata.data.statementDate ?? parsedFile.statementDate.toISOString(),
      currency: parsedMetadata.data.currency ?? parsedFile.currency ?? 'RON',
      openingBalance: parsedFile.openingBalance,
      closingBalance: parsedFile.closingBalance,
      sourceLabel: parsedMetadata.data.sourceLabel ?? parsedFile.sourceLabel,
      reason: parsedMetadata.data.reason,
      lines: parsedFile.lines.map((line) => ({
        date: line.date.toISOString(),
        amount: line.amount,
        description: line.description,
        reference: line.reference,
        counterpartyName: line.counterpartyName,
        counterpartyIban: line.counterpartyIban,
      })),
    });

    if (!payload.success) {
      res.status(400).json({ message: 'Datele extrase din fișier sunt invalide pentru import.' });
      return;
    }

    const statement = await importBankStatement({
      req,
      payload: payload.data,
    });

    res.status(201).json({
      statement,
      importSummary: {
        detectedFormat: parsedFile.detectedFormat,
        fileName: req.file.originalname,
        linesImported: payload.data.lines.length,
      },
    });
  },
);

router.get('/statements', requirePermissions(PERMISSIONS.BANK_RECONCILIATION_READ), async (req, res) => {
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: statementSortFields,
    defaultSortField: 'statementDate',
    defaultSortDirection: 'desc',
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  const where: Prisma.BankStatementWhereInput = query.search
    ? {
        companyId: req.user!.companyId!,
        OR: [
          { accountCode: { contains: query.search, mode: 'insensitive' } },
          { sourceLabel: { contains: query.search, mode: 'insensitive' } },
        ],
      }
    : {
        companyId: req.user!.companyId!,
      };

  const orderBy = buildStatementOrderBy(query.sortField, query.sortDirection);

  const [statements, totalCount] = await Promise.all([
    prisma.bankStatement.findMany({
      where,
      orderBy,
      skip: query.skip,
      take: query.take,
      include: {
        _count: {
          select: {
            lines: true,
          },
        },
      },
    }),
    prisma.bankStatement.count({ where }),
  ]);

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(statements);
});

router.get('/statements/:id/lines', requirePermissions(PERMISSIONS.BANK_RECONCILIATION_READ), async (req, res) => {
  const statementId = String(req.params.id);
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: lineSortFields,
    defaultSortField: 'date',
    defaultSortDirection: 'desc',
    defaultPageSize: 100,
    maxPageSize: 500,
  });

  const statusQuery = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
  const statusFilter = statusQuery && lineStatuses.has(statusQuery as BankStatementLineStatus)
    ? (statusQuery as BankStatementLineStatus)
    : undefined;

  const where: Prisma.BankStatementLineWhereInput = {
    statementId,
    companyId: req.user!.companyId!,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(query.search
      ? {
          OR: [
            { description: { contains: query.search, mode: 'insensitive' } },
            { reference: { contains: query.search, mode: 'insensitive' } },
            { counterpartyName: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const orderBy = buildLineOrderBy(query.sortField, query.sortDirection);

  const [lines, totalCount] = await Promise.all([
    prisma.bankStatementLine.findMany({
      where,
      orderBy,
      skip: query.skip,
      take: query.take,
    }),
    prisma.bankStatementLine.count({ where }),
  ]);

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(lines);
});

router.post('/lines/:id/suggest', requirePermissions(PERMISSIONS.BANK_RECONCILIATION_READ), async (req, res) => {
  const lineId = String(req.params.id);
  const takeRaw = Number(req.query.take ?? 10);
  const take = Number.isInteger(takeRaw) ? Math.min(Math.max(takeRaw, 1), 30) : 10;

  const line = await prisma.bankStatementLine.findFirst({
    where: {
      id: lineId,
      companyId: req.user!.companyId!,
    },
  });

  if (!line) {
    throw HttpError.notFound('Linia de extras nu există.');
  }

  const lineAmountAbs = round2(Math.abs(toNumber(line.amount)));

  if (toNumber(line.amount) > 0) {
    const invoices = await prisma.invoice.findMany({
      where: {
        companyId: req.user!.companyId!,
        status: {
          in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID],
        },
      },
      include: {
        partner: true,
        payments: true,
      },
      orderBy: [{ dueDate: 'asc' }, { issueDate: 'asc' }],
      take: 200,
    });

    const suggestions = invoices
      .map((invoice) => {
        const paid = round2(invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
        const openAmount = round2(Math.max(toNumber(invoice.total) - paid, 0));
        if (openAmount <= 0) {
          return null;
        }

        const scored = scoreSuggestion({
          expectedAmount: lineAmountAbs,
          openAmount,
          lineReference: line.reference,
          candidateNumber: invoice.number,
          lineDescription: line.description,
          candidatePartnerName: invoice.partner.name,
        });

        return {
          targetType: 'INVOICE' as const,
          targetId: invoice.id,
          number: invoice.number,
          partnerName: invoice.partner.name,
          openAmount,
          score: scored.score,
          reasons: scored.reasons,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => right.score - left.score)
      .slice(0, take);

    res.json({
      line,
      suggestions,
    });
    return;
  }

  const supplierInvoices = await prisma.supplierInvoice.findMany({
    where: {
      companyId: req.user!.companyId!,
      status: {
        in: [SupplierInvoiceStatus.RECEIVED, SupplierInvoiceStatus.PARTIALLY_PAID],
      },
    },
    include: {
      supplier: true,
      payments: true,
    },
    orderBy: [{ dueDate: 'asc' }, { receivedDate: 'asc' }],
    take: 200,
  });

  const suggestions = supplierInvoices
    .map((invoice) => {
      const paid = round2(invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
      const openAmount = round2(Math.max(toNumber(invoice.total) - paid, 0));
      if (openAmount <= 0) {
        return null;
      }

      const scored = scoreSuggestion({
        expectedAmount: lineAmountAbs,
        openAmount,
        lineReference: line.reference,
        candidateNumber: invoice.number,
        lineDescription: line.description,
        candidatePartnerName: invoice.supplier.name,
      });

      return {
        targetType: 'SUPPLIER_INVOICE' as const,
        targetId: invoice.id,
        number: invoice.number,
        partnerName: invoice.supplier.name,
        openAmount,
        score: scored.score,
        reasons: scored.reasons,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, take);

  res.json({
    line,
    suggestions,
  });
});

router.post('/lines/:id/reconcile', requirePermissions(PERMISSIONS.BANK_RECONCILIATION_WRITE), async (req, res) => {
  const lineId = String(req.params.id);
  const parsed = reconcileLineSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru reconciliere.' });
    return;
  }

  const companyId = req.user!.companyId!;

  const previewLine = await prisma.bankStatementLine.findFirst({
    where: {
      id: lineId,
      companyId,
    },
    select: {
      id: true,
      date: true,
      amount: true,
      status: true,
      reference: true,
    },
  });

  if (!previewLine) {
    throw HttpError.notFound('Linia de extras nu există.');
  }

  if (previewLine.status !== BankStatementLineStatus.UNMATCHED) {
    throw HttpError.conflict('Linia de extras este deja procesată.');
  }

  await assertPeriodOpen(companyId, currentPeriod(previewLine.date));

  const lineAmount = toNumber(previewLine.amount);
  const lineAmountAbs = round2(Math.abs(lineAmount));

  const result = await prisma.$transaction(async (tx) => {
    const line = await tx.bankStatementLine.findFirst({
      where: {
        id: lineId,
        companyId,
      },
    });

    if (!line) {
      throw HttpError.notFound('Linia de extras nu mai există.');
    }

    if (line.status !== BankStatementLineStatus.UNMATCHED) {
      throw HttpError.conflict('Linia de extras a fost deja reconciliată de altă operațiune.');
    }

    if (parsed.data.targetType === 'INVOICE') {
      if (lineAmount <= 0) {
        throw HttpError.badRequest('Liniile cu sumă negativă pot fi reconciliate doar cu facturi furnizor.');
      }

      const invoice = await tx.invoice.findFirst({
        where: {
          id: parsed.data.targetId,
          companyId,
        },
        include: {
          payments: true,
        },
      });

      if (!invoice) {
        throw HttpError.notFound('Factura client pentru reconciliere nu există.');
      }

      const paidBefore = round2(invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
      const openAmount = round2(Math.max(toNumber(invoice.total) - paidBefore, 0));
      if (lineAmountAbs > openAmount) {
        throw HttpError.badRequest(`Suma extrasului depășește soldul deschis al facturii (${openAmount.toFixed(2)}).`);
      }

      let bankAccountId: string | null = null;
      let receivableAccountId: string | null = null;

      if (parsed.data.autoPost) {
        const [bankAccount, receivableAccount] = await Promise.all([
          tx.account.findFirst({
            where: {
              companyId,
              code: parsed.data.bankAccountCode,
            },
          }),
          tx.account.findFirst({
            where: {
              companyId,
              code: parsed.data.receivableAccountCode,
            },
          }),
        ]);

        if (!bankAccount || !receivableAccount) {
          throw HttpError.badRequest('Conturi implicite lipsă pentru postarea automată a reconcilierii.');
        }

        bankAccountId = bankAccount.id;
        receivableAccountId = receivableAccount.id;
      }

      const payment = await tx.payment.create({
        data: {
          companyId,
          invoiceId: invoice.id,
          partnerId: invoice.partnerId,
          date: line.date,
          amount: lineAmountAbs,
          method: parsed.data.method as PaymentMethod,
          reference: parsed.data.reference ?? line.reference ?? undefined,
        },
      });

      const paidAfter = round2(paidBefore + lineAmountAbs);
      const nextStatus = paidAfter >= toNumber(invoice.total) ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID;

      const updatedInvoice = await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: nextStatus },
      });

      if (parsed.data.autoPost) {
        const journalNumber = await nextJournalEntryNumber(tx, companyId, line.date);
        await tx.journalEntry.create({
          data: {
            companyId,
            number: journalNumber,
            date: line.date,
            description: `Reconciliere bancară încasare ${invoice.number}`,
            period: currentPeriod(line.date),
            sourceModule: 'BANK_RECONCILIATION',
            createdById: req.user!.id,
            lines: {
              create: [
                {
                  accountId: bankAccountId!,
                  debit: lineAmountAbs,
                  credit: 0,
                  explanation: `Încasare reconciliată ${invoice.number}`,
                },
                {
                  accountId: receivableAccountId!,
                  debit: 0,
                  credit: lineAmountAbs,
                  explanation: `Stingere creanță ${invoice.number}`,
                },
              ],
            },
          },
        });
      }

      const reconciledLine = await tx.bankStatementLine.update({
        where: { id: line.id },
        data: {
          status: BankStatementLineStatus.MATCHED,
          matchedType: 'INVOICE',
          matchedRecordId: invoice.id,
          matchedAt: new Date(),
        },
      });

      await writeAudit(
        req,
        {
          tableName: 'bank_statement_lines',
          recordId: line.id,
          action: 'RECONCILE',
          reason: parsed.data.reason,
          afterData: {
            targetType: 'INVOICE',
            targetId: invoice.id,
            paymentId: payment.id,
          },
        },
        tx,
      );

      return {
        line: reconciledLine,
        payment,
        invoice: updatedInvoice,
      };
    }

    if (lineAmount >= 0) {
      throw HttpError.badRequest('Liniile cu sumă pozitivă pot fi reconciliate doar cu facturi client.');
    }

    const supplierInvoice = await tx.supplierInvoice.findFirst({
      where: {
        id: parsed.data.targetId,
        companyId,
      },
      include: {
        payments: true,
      },
    });

    if (!supplierInvoice) {
      throw HttpError.notFound('Factura furnizor pentru reconciliere nu există.');
    }

    const paidBefore = round2(supplierInvoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
    const openAmount = round2(Math.max(toNumber(supplierInvoice.total) - paidBefore, 0));
    if (lineAmountAbs > openAmount) {
      throw HttpError.badRequest(`Suma extrasului depășește soldul deschis al facturii (${openAmount.toFixed(2)}).`);
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
        throw HttpError.badRequest('Conturi implicite lipsă pentru postarea automată a reconcilierii.');
      }

      bankAccountId = bankAccount.id;
      payableAccountId = payableAccount.id;
    }

    const payment = await tx.supplierPayment.create({
      data: {
        companyId,
        supplierInvoiceId: supplierInvoice.id,
        supplierId: supplierInvoice.supplierId,
        date: line.date,
        amount: lineAmountAbs,
        method: parsed.data.method as PaymentMethod,
        reference: parsed.data.reference ?? line.reference ?? undefined,
      },
    });

    const paidAfter = round2(paidBefore + lineAmountAbs);
    const nextStatus =
      paidAfter >= toNumber(supplierInvoice.total) ? SupplierInvoiceStatus.PAID : SupplierInvoiceStatus.PARTIALLY_PAID;

    const updatedInvoice = await tx.supplierInvoice.update({
      where: { id: supplierInvoice.id },
      data: { status: nextStatus },
    });

    if (parsed.data.autoPost) {
      const journalNumber = await nextJournalEntryNumber(tx, companyId, line.date);
      await tx.journalEntry.create({
        data: {
          companyId,
          number: journalNumber,
          date: line.date,
          description: `Reconciliere bancară plată ${supplierInvoice.number}`,
          period: currentPeriod(line.date),
          sourceModule: 'BANK_RECONCILIATION',
          createdById: req.user!.id,
          lines: {
            create: [
              {
                accountId: payableAccountId!,
                debit: lineAmountAbs,
                credit: 0,
                explanation: `Stingere datorie ${supplierInvoice.number}`,
              },
              {
                accountId: bankAccountId!,
                debit: 0,
                credit: lineAmountAbs,
                explanation: `Plată reconciliată ${supplierInvoice.number}`,
              },
            ],
          },
        },
      });
    }

    const reconciledLine = await tx.bankStatementLine.update({
      where: { id: line.id },
      data: {
        status: BankStatementLineStatus.MATCHED,
        matchedType: 'SUPPLIER_INVOICE',
        matchedRecordId: supplierInvoice.id,
        matchedAt: new Date(),
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'bank_statement_lines',
        recordId: line.id,
        action: 'RECONCILE',
        reason: parsed.data.reason,
        afterData: {
          targetType: 'SUPPLIER_INVOICE',
          targetId: supplierInvoice.id,
          paymentId: payment.id,
        },
      },
      tx,
    );

    return {
      line: reconciledLine,
      payment,
      invoice: updatedInvoice,
    };
  });

  invalidateFinancialStatementsCache();
  res.status(201).json(result);
});

router.post('/lines/:id/ignore', requirePermissions(PERMISSIONS.BANK_RECONCILIATION_WRITE), async (req, res) => {
  const lineId = String(req.params.id);
  const parsed = ignoreLineSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru ignorarea liniei de extras.' });
    return;
  }

  const line = await prisma.$transaction(async (tx) => {
    const existing = await tx.bankStatementLine.findFirst({
      where: {
        id: lineId,
        companyId: req.user!.companyId!,
      },
    });

    if (!existing) {
      throw HttpError.notFound('Linia de extras nu există.');
    }

    if (existing.status !== BankStatementLineStatus.UNMATCHED) {
      throw HttpError.conflict('Linia de extras este deja procesată.');
    }

    const updated = await tx.bankStatementLine.update({
      where: {
        id: existing.id,
      },
      data: {
        status: BankStatementLineStatus.IGNORED,
        matchedType: null,
        matchedRecordId: null,
        matchedAt: null,
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'bank_statement_lines',
        recordId: updated.id,
        action: 'IGNORE',
        reason: parsed.data.reason,
      },
      tx,
    );

    return updated;
  });

  res.json(line);
});

export default router;
