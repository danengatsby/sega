import type { AccountType } from '@prisma/client';
import type { AnafDeclarationType } from '../../utils/anaf.js';

export interface DateRange {
  from?: Date;
  to?: Date;
}

export interface AnafPeriod {
  period: string;
  start: Date;
  end: Date;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  debit: number;
  credit: number;
}

export interface TrialBalanceData {
  rows: TrialBalanceRow[];
  totals: {
    debit: number;
    credit: number;
  };
}

export interface PnLData {
  revenues: number;
  expenses: number;
  netProfit: number;
}

export interface BalanceSheetData {
  assets: number;
  liabilities: number;
  equity: number;
  liabilitiesAndEquity: number;
}

export interface AgingData {
  buckets: {
    current: number;
    d1_30: number;
    d31_60: number;
    d61_90: number;
    d90_plus: number;
  };
  rows: Array<{
    invoiceId: string;
    number: string;
    partner: string;
    dueDate: Date;
    openAmount: number;
    overdueDays: number;
  }>;
}

export interface TaxSummary {
  taxableSales: number;
  vatCollected: number;
  payrollCas: number;
  payrollCass: number;
  payrollCam: number;
  payrollTax: number;
  estimatedProfitTax: number;
  totalFiscalLiabilities: number;
}

export interface FinancialStatementBundle {
  meta: {
    generatedAt: string;
    from: string | null;
    to: string | null;
  };
  trialBalance: TrialBalanceData;
  pnl: PnLData;
  balanceSheet: BalanceSheetData;
  aging: AgingData;
  taxSummary: TaxSummary;
}

export interface AnafDeclarationPayload {
  type: AnafDeclarationType;
  period: string;
  xml: string;
  rowCount: number;
}

export interface AnafValidationSummary {
  declaration: string;
  period: string;
  profile: {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
  xsd: {
    performed: boolean;
    valid: boolean | null;
    validator: 'xmllint' | 'none';
    schemaPath: string | null;
    errors: string[];
    warnings: string[];
  };
}
