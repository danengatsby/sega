export type Role =
  | 'ADMIN'
  | 'CHIEF_ACCOUNTANT'
  | 'ACCOUNTANT'
  | 'CASHIER'
  | 'MANAGER'
  | 'AUDITOR';

export type Permission =
  | 'accounts.read'
  | 'accounts.write'
  | 'partners.read'
  | 'partners.write'
  | 'invoices.read'
  | 'invoices.write'
  | 'payments.write'
  | 'purchases.read'
  | 'purchases.write'
  | 'purchases.approve'
  | 'purchases.delegate'
  | 'purchases.payments.write'
  | 'stocks.read'
  | 'stocks.write'
  | 'bank-reconciliation.read'
  | 'bank-reconciliation.write'
  | 'journal.read'
  | 'journal.write'
  | 'employees.read'
  | 'employees.write'
  | 'payroll.read'
  | 'payroll.generate'
  | 'assets.read'
  | 'assets.write'
  | 'assets.run-depreciation'
  | 'reports.read'
  | 'reports.export'
  | 'export-jobs.read'
  | 'export-jobs.write'
  | 'dashboard-snapshots.read'
  | 'dashboard-snapshots.write'
  | 'audit.read'
  | 'periods.read'
  | 'periods.manage';

export interface AvailableCompany {
  id: string;
  code: string;
  name: string;
  role: Role;
  isDefault: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  mfaEnabled?: boolean;
  companyOnboardingRequired?: boolean;
  companyId: string;
  companyCode: string;
  companyName: string;
  companyRole: Role;
  permissions: Permission[];
  availableCompanies: AvailableCompany[];
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  currency: string;
  isActive: boolean;
}

export interface Partner {
  id: string;
  name: string;
  cui: string | null;
  iban: string | null;
  type: 'CUSTOMER' | 'SUPPLIER' | 'BOTH';
  email: string | null;
  phone: string | null;
}

export interface Payment {
  id: string;
  amount: string;
  method: 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'OTHER';
  date: string;
  reference?: string | null;
}

export interface SupplierPayment {
  id: string;
  amount: string;
  method: 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'OTHER';
  date: string;
  reference?: string | null;
}

export interface Invoice {
  id: string;
  number: string;
  kind: 'PROFORMA' | 'FISCAL' | 'STORNO';
  stornoOfInvoiceId?: string | null;
  issueDate: string;
  dueDate: string;
  subtotal: string;
  vat: string;
  total: string;
  status: 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';
  partnerId: string;
  partner: Partner;
  payments: Payment[];
}

export interface SupplierInvoice {
  id: string;
  number: string;
  supplierId: string;
  supplier: Partner;
  receivedDate: string;
  dueDate: string;
  subtotal: string;
  vat: string;
  total: string;
  currency: string;
  description: string | null;
  status: 'DRAFT' | 'RECEIVED' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED';
  approvalStatus:
    | 'PENDING_LEVEL_1'
    | 'PENDING_LEVEL_2'
    | 'PENDING_LEVEL_3'
    | 'PENDING_LEVEL_4'
    | 'APPROVED'
    | 'REJECTED';
  approvalCurrentLevel: number;
  approvalRequiredLevel: number;
  approvalRequestedAt: string | null;
  approvalFinalizedAt: string | null;
  approvalRejectedReason: string | null;
  approvals?: SupplierInvoiceApproval[];
  payments: SupplierPayment[];
}

export interface SupplierInvoiceApproval {
  id: string;
  level: number;
  action: 'APPROVE' | 'REJECT';
  channel: 'WEB' | 'MOBILE';
  note: string | null;
  approvedById: string;
  delegatedFromUserId: string | null;
  createdAt: string;
  approvedBy?: {
    id: string;
    name: string;
    email: string;
  };
  delegatedFrom?: {
    id: string;
    name: string;
    email: string;
  } | null;
}

export interface PurchaseApproverUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface PurchaseApprovalDelegation {
  id: string;
  scope: 'PURCHASES_SUPPLIER_INVOICE_APPROVAL';
  fromUserId: string;
  toUserId: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  reason: string | null;
  fromUser: {
    id: string;
    name: string;
    email: string;
  };
  toUser: {
    id: string;
    name: string;
    email: string;
  };
}

export interface StockItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  valuationMethod: 'FIFO' | 'CMP';
  minStockQty: string;
  quantityOnHand: string;
  avgUnitCost: string;
  isActive: boolean;
}

export interface StockMovement {
  id: string;
  itemId: string;
  type: 'NIR' | 'CONSUMPTION' | 'INVENTORY_PLUS' | 'INVENTORY_MINUS';
  movementDate: string;
  quantity: string;
  unitCost: string;
  totalCost: string;
  resultingQuantity: string;
  documentNumber: string | null;
  note: string | null;
  sourceLots?: Array<{
    lotId: string;
    quantity: number;
    unitCost: number;
  }> | null;
  item: {
    id: string;
    code: string;
    name: string;
    unit: string;
    valuationMethod: 'FIFO' | 'CMP';
  };
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totals: {
    debit: number;
    credit: number;
  };
}

export interface PnLReport {
  revenues: number;
  expenses: number;
  netProfit: number;
}

export interface BalanceSheet {
  assets: number;
  liabilities: number;
  equity: number;
  liabilitiesAndEquity: number;
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

export interface FinancialStatements {
  meta: {
    generatedAt: string;
    from: string | null;
    to: string | null;
  };
  trialBalance: TrialBalance;
  pnl: PnLReport;
  balanceSheet: BalanceSheet;
  aging: AgingReport;
  taxSummary: TaxSummary;
}

export interface AgingReport {
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
    dueDate: string;
    openAmount: number;
    overdueDays: number;
  }>;
}

export interface PurchasesDashboardTopSupplier {
  supplierId: string;
  supplierName: string;
  openAmount: number;
  overdueAmount: number;
  invoicesCount: number;
  overdueInvoicesCount: number;
  earliestDueDate: string;
}

export interface PurchasesDashboard {
  asOf: string;
  next7DaysUntil: string;
  totals: {
    openAmount: number;
    overdueAmount: number;
    dueNext7DaysAmount: number;
    openInvoicesCount: number;
    overdueInvoicesCount: number;
    topSuppliersCount: number;
  };
  topSuppliers: PurchasesDashboardTopSupplier[];
}

export type DashboardBiAlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type DashboardBiAlertType =
  | 'RECEIVABLE_OVERDUE'
  | 'RECEIVABLE_DUE_SOON'
  | 'PAYABLE_OVERDUE'
  | 'PAYABLE_DUE_SOON';

export interface DashboardBiForecastRow {
  horizonDays: 30 | 60 | 90;
  horizonDate: string;
  inflowReceivables: number;
  outflowPayables: number;
  netCashflow: number;
  projectedClosingBalance: number;
  receivablesCount: number;
  payablesCount: number;
}

export interface DashboardBiAlertItem {
  id: string;
  type: DashboardBiAlertType;
  severity: DashboardBiAlertSeverity;
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
    horizons: DashboardBiForecastRow[];
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
    items: DashboardBiAlertItem[];
  };
}

export interface AuditLog {
  id: string;
  tableName: string;
  action: string;
  reason: string | null;
  timestamp: string;
  ipAddress: string | null;
  userAgent: string | null;
  user: User | null;
}

export interface JournalEntry {
  id: string;
  number?: string | null;
  date: string;
  description: string;
  period: string;
  status?: 'DRAFT' | 'VALIDATED' | 'CLOSED';
  reversalOfEntryId?: string | null;
  lines: Array<{
    id: string;
    accountId: string;
    debit: string;
    credit: string;
    account: Account;
  }>;
}

export interface Employee {
  id: string;
  cnp: string;
  name: string;
  contractType: string;
  grossSalary: string;
  personalDeduction: string;
  isActive: boolean;
  hiredAt: string;
}

export interface PayrollLine {
  id: string;
  employeeId: string;
  grossSalary: string;
  personalDeduction: string;
  cas: string;
  cass: string;
  incomeTax: string;
  cam: string;
  netSalary: string;
  employee: Employee;
}

export interface PayrollRun {
  id: string;
  period: string;
  payDate: string;
  status: 'DRAFT' | 'POSTED';
  totalGross: string;
  totalNet: string;
  totalCas: string;
  totalCass: string;
  totalCam: string;
  totalTax: string;
  lines: PayrollLine[];
}

export interface AssetDepreciation {
  id: string;
  period: string;
  depreciationDate: string;
  depreciationAmount: string;
  accumulatedAmount: string;
  bookValue: string;
}

export interface Asset {
  id: string;
  code: string | null;
  name: string;
  value: string;
  residualValue: string;
  depreciationMethod: 'LINEAR' | 'DEGRESSIVE' | 'ACCELERATED';
  usefulLifeMonths: number;
  startDate: string;
  isActive: boolean;
  depreciationRecords: AssetDepreciation[];
}

export type RevisalDeliveryStatus = 'GENERATED' | 'DELIVERED' | 'FAILED';

export type RevisalDeliveryChannel = 'WEB_PORTAL' | 'EMAIL' | 'SFTP' | 'MANUAL_UPLOAD' | 'OTHER';

export interface RevisalDelivery {
  id: string;
  period: string;
  deliveryReference: string;
  status: RevisalDeliveryStatus;
  channel: RevisalDeliveryChannel | null;
  deliveredAt: string | null;
  receiptNumber: string | null;
  employeeCount: number;
  xmlChecksum: string;
  validationPerformed: boolean;
  validationPassed: boolean | null;
  validationErrors?: unknown;
  validationWarnings?: unknown;
  createdAt: string;
  updatedAt?: string;
  initiatedBy?: {
    id: string;
    name: string;
    email: string;
  };
  warnings?: string[];
}
