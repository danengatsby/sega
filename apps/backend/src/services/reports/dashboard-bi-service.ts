import { AccountType, InvoiceStatus, SupplierInvoiceStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { getCachedFinancialStatements } from '../../lib/financial-statements-cache.js';
import { prisma } from '../../lib/prisma.js';
import { round2, toNumber } from '../../utils/number.js';
import { getStatements } from './statements-service.js';

const OPEN_RECEIVABLE_STATUSES: InvoiceStatus[] = [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID];
const OPEN_PAYABLE_STATUSES: SupplierInvoiceStatus[] = [SupplierInvoiceStatus.RECEIVED, SupplierInvoiceStatus.PARTIALLY_PAID];
const DAY_MS = 24 * 60 * 60 * 1000;
const FORECAST_HORIZONS_DAYS = [30, 60, 90] as const;

export interface DashboardBiOptions {
  asOf: Date;
  dueSoonDays: number;
  overdueGraceDays: number;
  minAmount: number;
  maxAlerts: number;
}

type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
type AlertType = 'RECEIVABLE_OVERDUE' | 'RECEIVABLE_DUE_SOON' | 'PAYABLE_OVERDUE' | 'PAYABLE_DUE_SOON';

interface OpenDocumentItem {
  id: string;
  number: string;
  partnerName: string;
  dueDate: Date;
  openAmount: number;
  daysFromDue: number;
  source: 'RECEIVABLE' | 'PAYABLE';
}

interface DashboardAlertItem {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  source: 'RECEIVABLE' | 'PAYABLE';
  title: string;
  message: string;
  documentId: string;
  documentNumber: string;
  partnerName: string;
  dueDate: string;
  amount: number;
  daysOverdue: number | null;
  daysUntilDue: number | null;
}

interface DashboardForecastRow {
  horizonDays: 30 | 60 | 90;
  horizonDate: string;
  inflowReceivables: number;
  outflowPayables: number;
  netCashflow: number;
  projectedClosingBalance: number;
  receivablesCount: number;
  payablesCount: number;
}

export interface DashboardBiReport {
  asOf: string;
  kpis: {
    receivablesOpenAmount: number;
    receivablesOverdueAmount: number;
    receivablesDueSoonAmount: number;
    payablesOpenAmount: number;
    payablesOverdueAmount: number;
    payablesDueSoonAmount: number;
    netOpenPosition: number;
    overdueNetExposure: number;
    cashPosition: number;
    netWorkingCapital: number;
    currentRatio: number | null;
    netProfitMarginPct: number | null;
    totalFiscalLiabilities: number;
  };
  forecast: {
    openingCashPosition: number;
    horizons: DashboardForecastRow[];
    assumptions: {
      dueSoonDays: number;
      includeOverdueInForecast: true;
    };
  };
  alerts: {
    config: {
      dueSoonDays: number;
      overdueGraceDays: number;
      minAmount: number;
      maxAlerts: number;
    };
    summary: {
      total: number;
      critical: number;
      warning: number;
      info: number;
    };
    items: DashboardAlertItem[];
  };
}

function startOfDay(value: Date): Date {
  const result = new Date(value);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(value: Date): Date {
  const result = new Date(value);
  result.setHours(23, 59, 59, 999);
  return result;
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function daysDiff(left: Date, right: Date): number {
  return Math.floor((left.getTime() - right.getTime()) / DAY_MS);
}

function dashboardCacheKey(companyId: string, options: DashboardBiOptions): string {
  const asOfStart = startOfDay(options.asOf).toISOString();
  return [
    'dashboard-bi',
    companyId,
    asOfStart,
    String(options.dueSoonDays),
    String(options.overdueGraceDays),
    String(options.minAmount),
    String(options.maxAlerts),
  ].join('|');
}

function signedBalanceForAccount(type: AccountType, debit: number, credit: number): number {
  const value = round2(debit - credit);
  if (type === AccountType.ASSET || type === AccountType.EXPENSE) {
    return value;
  }
  return round2(-value);
}

function isCashAccount(code: string): boolean {
  return code.startsWith('51') || code.startsWith('53');
}

function severityRank(severity: AlertSeverity): number {
  if (severity === 'CRITICAL') {
    return 3;
  }
  if (severity === 'WARNING') {
    return 2;
  }
  return 1;
}

function buildAlert(item: OpenDocumentItem, type: AlertType, severity: AlertSeverity): DashboardAlertItem {
  const daysOverdue = item.daysFromDue > 0 ? item.daysFromDue : null;
  const daysUntilDue = item.daysFromDue <= 0 ? Math.abs(item.daysFromDue) : null;
  const sourceLabel = item.source === 'RECEIVABLE' ? 'încasare' : 'plată';

  const titleByType: Record<AlertType, string> = {
    RECEIVABLE_OVERDUE: 'Creanță restantă',
    RECEIVABLE_DUE_SOON: 'Creanță scadentă curând',
    PAYABLE_OVERDUE: 'Datorie restantă',
    PAYABLE_DUE_SOON: 'Datorie scadentă curând',
  };

  const detail =
    daysOverdue !== null
      ? `${daysOverdue} zile restante`
      : `${daysUntilDue ?? 0} zile până la scadență`;

  return {
    id: `${item.source}:${type}:${item.id}`,
    type,
    severity,
    source: item.source,
    title: titleByType[type],
    message: `${sourceLabel} ${item.number} (${item.partnerName}) - ${detail}`,
    documentId: item.id,
    documentNumber: item.number,
    partnerName: item.partnerName,
    dueDate: item.dueDate.toISOString(),
    amount: item.openAmount,
    daysOverdue,
    daysUntilDue,
  };
}

function sortAlerts(left: DashboardAlertItem, right: DashboardAlertItem): number {
  const severityDelta = severityRank(right.severity) - severityRank(left.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const leftDueTime = new Date(left.dueDate).getTime();
  const rightDueTime = new Date(right.dueDate).getTime();
  if (leftDueTime !== rightDueTime) {
    return leftDueTime - rightDueTime;
  }

  if (right.amount !== left.amount) {
    return right.amount - left.amount;
  }

  return left.documentNumber.localeCompare(right.documentNumber, 'ro');
}

async function loadOpenReceivables(companyId: string, asOfStart: Date): Promise<OpenDocumentItem[]> {
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      status: {
        in: OPEN_RECEIVABLE_STATUSES,
      },
    },
    include: {
      partner: {
        select: {
          name: true,
        },
      },
      payments: {
        select: {
          amount: true,
        },
      },
    },
    orderBy: [{ dueDate: 'asc' }, { issueDate: 'asc' }],
  });

  const rows: OpenDocumentItem[] = [];
  for (const invoice of invoices) {
    const paid = round2(invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
    const openAmount = round2(Math.max(toNumber(invoice.total) - paid, 0));
    if (openAmount <= 0) {
      continue;
    }

    rows.push({
      id: invoice.id,
      number: invoice.number,
      partnerName: invoice.partner.name,
      dueDate: invoice.dueDate,
      openAmount,
      daysFromDue: daysDiff(asOfStart, invoice.dueDate),
      source: 'RECEIVABLE',
    });
  }

  return rows;
}

async function loadOpenPayables(companyId: string, asOfStart: Date): Promise<OpenDocumentItem[]> {
  const invoices = await prisma.supplierInvoice.findMany({
    where: {
      companyId,
      status: {
        in: OPEN_PAYABLE_STATUSES,
      },
    },
    include: {
      supplier: {
        select: {
          name: true,
        },
      },
      payments: {
        select: {
          amount: true,
        },
      },
    },
    orderBy: [{ dueDate: 'asc' }, { receivedDate: 'asc' }],
  });

  const rows: OpenDocumentItem[] = [];
  for (const invoice of invoices) {
    const paid = round2(invoice.payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
    const openAmount = round2(Math.max(toNumber(invoice.total) - paid, 0));
    if (openAmount <= 0) {
      continue;
    }

    rows.push({
      id: invoice.id,
      number: invoice.number,
      partnerName: invoice.supplier.name,
      dueDate: invoice.dueDate,
      openAmount,
      daysFromDue: daysDiff(asOfStart, invoice.dueDate),
      source: 'PAYABLE',
    });
  }

  return rows;
}

function sumAmounts(items: OpenDocumentItem[]): number {
  return round2(items.reduce((sum, item) => sum + item.openAmount, 0));
}

function computeAlerts(
  receivables: OpenDocumentItem[],
  payables: OpenDocumentItem[],
  options: DashboardBiOptions,
): DashboardBiReport['alerts'] {
  const items: DashboardAlertItem[] = [];

  const buildForItem = (item: OpenDocumentItem): void => {
    if (item.openAmount < options.minAmount) {
      return;
    }

    if (item.daysFromDue > options.overdueGraceDays) {
      if (item.source === 'RECEIVABLE') {
        items.push(buildAlert(item, 'RECEIVABLE_OVERDUE', item.daysFromDue > 30 ? 'CRITICAL' : 'WARNING'));
      } else {
        items.push(buildAlert(item, 'PAYABLE_OVERDUE', item.daysFromDue > 15 ? 'CRITICAL' : 'WARNING'));
      }
      return;
    }

    if (item.daysFromDue <= 0 && Math.abs(item.daysFromDue) <= options.dueSoonDays) {
      const severity: AlertSeverity = Math.abs(item.daysFromDue) <= 2 ? 'WARNING' : 'INFO';
      if (item.source === 'RECEIVABLE') {
        items.push(buildAlert(item, 'RECEIVABLE_DUE_SOON', severity));
      } else {
        items.push(buildAlert(item, 'PAYABLE_DUE_SOON', severity));
      }
    }
  };

  for (const receivable of receivables) {
    buildForItem(receivable);
  }
  for (const payable of payables) {
    buildForItem(payable);
  }

  const sorted = items.sort(sortAlerts).slice(0, options.maxAlerts);
  const summary = sorted.reduce(
    (acc, item) => {
      if (item.severity === 'CRITICAL') {
        acc.critical += 1;
      } else if (item.severity === 'WARNING') {
        acc.warning += 1;
      } else {
        acc.info += 1;
      }
      return acc;
    },
    {
      total: sorted.length,
      critical: 0,
      warning: 0,
      info: 0,
    },
  );

  return {
    config: {
      dueSoonDays: options.dueSoonDays,
      overdueGraceDays: options.overdueGraceDays,
      minAmount: options.minAmount,
      maxAlerts: options.maxAlerts,
    },
    summary,
    items: sorted,
  };
}

function computeForecast(
  receivables: OpenDocumentItem[],
  payables: OpenDocumentItem[],
  asOfStart: Date,
  openingCashPosition: number,
  dueSoonDays: number,
): DashboardBiReport['forecast'] {
  const horizons: DashboardForecastRow[] = FORECAST_HORIZONS_DAYS.map((horizonDays) => {
    const horizonEnd = endOfDay(addDays(asOfStart, horizonDays));
    const inflowItems = receivables.filter((item) => item.dueDate <= horizonEnd);
    const outflowItems = payables.filter((item) => item.dueDate <= horizonEnd);
    const inflowReceivables = sumAmounts(inflowItems);
    const outflowPayables = sumAmounts(outflowItems);
    const netCashflow = round2(inflowReceivables - outflowPayables);
    const projectedClosingBalance = round2(openingCashPosition + netCashflow);

    return {
      horizonDays,
      horizonDate: horizonEnd.toISOString(),
      inflowReceivables,
      outflowPayables,
      netCashflow,
      projectedClosingBalance,
      receivablesCount: inflowItems.length,
      payablesCount: outflowItems.length,
    };
  });

  return {
    openingCashPosition,
    horizons,
    assumptions: {
      dueSoonDays,
      includeOverdueInForecast: true,
    },
  };
}

async function computeDashboardBiReport(companyId: string, options: DashboardBiOptions): Promise<DashboardBiReport> {
  const asOfStart = startOfDay(options.asOf);
  const yearStart = new Date(Date.UTC(asOfStart.getUTCFullYear(), 0, 1, 0, 0, 0, 0));

  const [bundle, receivables, payables] = await Promise.all([
    getStatements(companyId, { from: yearStart, to: endOfDay(asOfStart) }),
    loadOpenReceivables(companyId, asOfStart),
    loadOpenPayables(companyId, asOfStart),
  ]);

  const receivablesOpenAmount = sumAmounts(receivables);
  const receivablesOverdueAmount = sumAmounts(receivables.filter((item) => item.daysFromDue > 0));
  const receivablesDueSoonAmount = sumAmounts(
    receivables.filter((item) => item.daysFromDue <= 0 && Math.abs(item.daysFromDue) <= options.dueSoonDays),
  );

  const payablesOpenAmount = sumAmounts(payables);
  const payablesOverdueAmount = sumAmounts(payables.filter((item) => item.daysFromDue > 0));
  const payablesDueSoonAmount = sumAmounts(
    payables.filter((item) => item.daysFromDue <= 0 && Math.abs(item.daysFromDue) <= options.dueSoonDays),
  );

  const cashPosition = round2(
    bundle.trialBalance.rows
      .filter((row) => isCashAccount(row.code))
      .reduce((sum, row) => sum + signedBalanceForAccount(row.type, row.debit, row.credit), 0),
  );

  const currentRatio = bundle.balanceSheet.liabilities > 0 ? round2(bundle.balanceSheet.assets / bundle.balanceSheet.liabilities) : null;
  const netProfitMarginPct = bundle.pnl.revenues > 0 ? round2((bundle.pnl.netProfit / bundle.pnl.revenues) * 100) : null;

  return {
    asOf: asOfStart.toISOString(),
    kpis: {
      receivablesOpenAmount,
      receivablesOverdueAmount,
      receivablesDueSoonAmount,
      payablesOpenAmount,
      payablesOverdueAmount,
      payablesDueSoonAmount,
      netOpenPosition: round2(receivablesOpenAmount - payablesOpenAmount),
      overdueNetExposure: round2(receivablesOverdueAmount - payablesOverdueAmount),
      cashPosition,
      netWorkingCapital: round2(bundle.balanceSheet.assets - bundle.balanceSheet.liabilities),
      currentRatio,
      netProfitMarginPct,
      totalFiscalLiabilities: bundle.taxSummary.totalFiscalLiabilities,
    },
    forecast: computeForecast(receivables, payables, asOfStart, cashPosition, options.dueSoonDays),
    alerts: computeAlerts(receivables, payables, options),
  };
}

export async function buildDashboardBiReport(companyId: string, options: DashboardBiOptions): Promise<DashboardBiReport> {
  const key = dashboardCacheKey(companyId, options);
  return getCachedFinancialStatements(key, env.REPORTS_CACHE_TTL_MS, () => computeDashboardBiReport(companyId, options));
}
