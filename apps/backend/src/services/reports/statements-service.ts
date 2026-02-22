import { AccountType, InvoiceStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { getCachedFinancialStatements } from '../../lib/financial-statements-cache.js';
import { prisma } from '../../lib/prisma.js';
import { round2, toNumber } from '../../utils/number.js';
import { hasRange } from './helpers.js';
import type { AgingData, DateRange, FinancialStatementBundle, PnLData, BalanceSheetData, TrialBalanceRow, TaxSummary } from './types.js';

function rangeCacheKey(range: DateRange): string {
  const from = range.from ? range.from.toISOString() : '';
  const to = range.to ? range.to.toISOString() : '';
  return `${from}|${to}`;
}

async function computeAging(companyId: string, range: DateRange): Promise<AgingData> {
  const invoiceWhere = hasRange(range)
    ? {
        companyId,
        status: {
          in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID] as InvoiceStatus[],
        },
        issueDate: {
          gte: range.from,
          lte: range.to,
        },
      }
    : {
        companyId,
        status: {
          in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID] as InvoiceStatus[],
        },
      };

  const invoices = await prisma.invoice.findMany({
    where: invoiceWhere,
    include: {
      payments: true,
      partner: true,
    },
  });

  const now = new Date();
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
    const diffDays = Math.floor((now.getTime() - invoice.dueDate.getTime()) / (1000 * 60 * 60 * 24));

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
      invoiceId: invoice.id,
      number: invoice.number,
      partner: invoice.partner.name,
      dueDate: invoice.dueDate,
      openAmount,
      overdueDays: Math.max(diffDays, 0),
    };
  });

  return { buckets, rows };
}

async function computeStatements(companyId: string, range: DateRange): Promise<FinancialStatementBundle> {
  const journalWhere = hasRange(range)
    ? {
        entry: {
          companyId,
          date: {
            gte: range.from,
            lte: range.to,
          },
        },
      }
    : {
        entry: {
          companyId,
        },
      };

  const lines = await prisma.journalLine.findMany({
    where: journalWhere,
    include: {
      account: true,
    },
  });

  const map = new Map<string, TrialBalanceRow>();

  for (const line of lines) {
    const current =
      map.get(line.accountId) ?? {
        accountId: line.accountId,
        code: line.account.code,
        name: line.account.name,
        type: line.account.type,
        debit: 0,
        credit: 0,
      };

    current.debit = round2(current.debit + toNumber(line.debit));
    current.credit = round2(current.credit + toNumber(line.credit));
    map.set(line.accountId, current);
  }

  const trialRows = [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  const trialTotals = trialRows.reduce(
    (acc, row) => {
      acc.debit = round2(acc.debit + row.debit);
      acc.credit = round2(acc.credit + row.credit);
      return acc;
    },
    { debit: 0, credit: 0 },
  );

  let revenues = 0;
  let expenses = 0;
  let assets = 0;
  let liabilities = 0;
  let equity = 0;

  for (const row of trialRows) {
    const accountBalance = round2(row.debit - row.credit);

    if (row.type === AccountType.REVENUE) {
      revenues = round2(revenues + (row.credit - row.debit));
    }

    if (row.type === AccountType.EXPENSE) {
      expenses = round2(expenses + (row.debit - row.credit));
    }

    if (row.type === AccountType.ASSET) {
      assets = round2(assets + accountBalance);
    }

    if (row.type === AccountType.LIABILITY) {
      liabilities = round2(liabilities - accountBalance);
    }

    if (row.type === AccountType.EQUITY) {
      equity = round2(equity - accountBalance);
    }
  }

  const pnl: PnLData = {
    revenues,
    expenses,
    netProfit: round2(revenues - expenses),
  };

  const balanceSheet: BalanceSheetData = {
    assets,
    liabilities,
    equity,
    liabilitiesAndEquity: round2(liabilities + equity),
  };

  const taxableInvoiceWhere = hasRange(range)
    ? {
        companyId,
        status: {
          not: InvoiceStatus.CANCELLED,
        },
        issueDate: {
          gte: range.from,
          lte: range.to,
        },
      }
    : {
        companyId,
        status: {
          not: InvoiceStatus.CANCELLED,
        },
      };

  const [invoicesForTaxes, payrollRuns, aging] = await Promise.all([
    prisma.invoice.findMany({ where: taxableInvoiceWhere }),
    prisma.payrollRun.findMany({
      where: hasRange(range)
        ? {
            companyId,
            payDate: {
              gte: range.from,
              lte: range.to,
            },
          }
        : {
            companyId,
          },
    }),
    computeAging(companyId, range),
  ]);

  const taxableSales = round2(invoicesForTaxes.reduce((sum, invoice) => sum + toNumber(invoice.subtotal), 0));
  const vatCollected = round2(invoicesForTaxes.reduce((sum, invoice) => sum + toNumber(invoice.vat), 0));
  const payrollCas = round2(payrollRuns.reduce((sum, run) => sum + toNumber(run.totalCas), 0));
  const payrollCass = round2(payrollRuns.reduce((sum, run) => sum + toNumber(run.totalCass), 0));
  const payrollCam = round2(payrollRuns.reduce((sum, run) => sum + toNumber(run.totalCam), 0));
  const payrollTax = round2(payrollRuns.reduce((sum, run) => sum + toNumber(run.totalTax), 0));
  const estimatedProfitTax = round2(Math.max(pnl.netProfit, 0) * 0.16);

  const taxSummary: TaxSummary = {
    taxableSales,
    vatCollected,
    payrollCas,
    payrollCass,
    payrollCam,
    payrollTax,
    estimatedProfitTax,
    totalFiscalLiabilities: round2(vatCollected + payrollCas + payrollCass + payrollCam + payrollTax + estimatedProfitTax),
  };

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      from: range.from ? range.from.toISOString() : null,
      to: range.to ? range.to.toISOString() : null,
    },
    trialBalance: {
      rows: trialRows,
      totals: trialTotals,
    },
    pnl,
    balanceSheet,
    aging,
    taxSummary,
  };
}

export async function getStatements(companyId: string, range: DateRange): Promise<FinancialStatementBundle> {
  const key = `${companyId}|${rangeCacheKey(range)}`;
  return getCachedFinancialStatements(key, env.REPORTS_CACHE_TTL_MS, () => computeStatements(companyId, range));
}
