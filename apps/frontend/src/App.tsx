import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL, ApiError, apiRequest, setApiCompanyContext } from './api';
import { type ModuleKey } from './app/navigation';
import { CompanyOnboardingScreen } from './components/auth/CompanyOnboardingScreen';
import { LoginScreen } from './components/auth/LoginScreen';
import { MfaEnrollmentScreen } from './components/auth/MfaEnrollmentScreen';
import { PasswordChangeScreen } from './components/auth/PasswordChangeScreen';
import { useAuthStorage } from './hooks/useAuthStorage';
import { usePermissions } from './hooks/usePermissions';
import { fmtCurrency, localDateTime, toNum } from './lib/format';
import {
  type OfflineWriteMethod,
  type OfflineWriteOperation,
  buildOfflineWriteOperation,
  persistOfflineWriteQueue,
  readOfflineWriteQueue,
} from './lib/offline-queue';
import { AccountsPage } from './pages/AccountsPage';
import { AssetsPage } from './pages/AssetsPage';
import { AuditPage } from './pages/AuditPage';
import { DashboardPage } from './pages/DashboardPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { JournalPage } from './pages/JournalPage';
import { PartnersPage } from './pages/PartnersPage';
import { PayrollPage } from './pages/PayrollPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { RevisalPage } from './pages/RevisalPage';
import { ReportsPage } from './pages/ReportsPage';
import { StocksPage } from './pages/StocksPage';
import { AdminPage } from './pages/AdminPage';
import type {
  Account,
  AgingReport,
  Asset,
  AuditLog,
  BalanceSheet,
  DashboardBiReport,
  Employee,
  FinancialStatements,
  Invoice,
  JournalEntry,
  Partner,
  PayrollRun,
  PnLReport,
  PurchaseApprovalDelegation,
  PurchaseApproverUser,
  PurchasesDashboard,
  RevisalDelivery,
  RevisalDeliveryChannel,
  StockItem,
  StockMovement,
  SupplierInvoice,
  TrialBalance,
  User,
} from './types';

type PaymentDialogFlow = 'INVOICE_COLLECTION' | 'SUPPLIER_PAYMENT';
type PaymentDialogMethod = 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'OTHER';

interface PaymentDialogState {
  flow: PaymentDialogFlow;
  invoiceId: string;
  invoiceNumber: string;
  partnerName: string;
  openAmount: number;
  amount: string;
  method: PaymentDialogMethod;
  reference: string;
  date: string;
  autoPost: boolean;
}

interface MfaSetupPayload {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  accountName: string;
}

interface LoginHintCredentials {
  label: string;
  email: string;
  password: string;
}

interface WriteExecutionResult {
  queued: boolean;
}

const MODULE_CACHE_TTL_MS = 30_000;
const MFA_REQUIRED_ROLES = new Set<User['role']>(['ADMIN', 'CHIEF_ACCOUNTANT']);
const FIXED_PERIOD_YEAR = 2026;
const MONTH_OPTIONS = [
  { value: '01', label: 'Ian' },
  { value: '02', label: 'Feb' },
  { value: '03', label: 'Mar' },
  { value: '04', label: 'Apr' },
  { value: '05', label: 'Mai' },
  { value: '06', label: 'Iun' },
  { value: '07', label: 'Iul' },
  { value: '08', label: 'Aug' },
  { value: '09', label: 'Sep' },
  { value: '10', label: 'Oct' },
  { value: '11', label: 'Noi' },
  { value: '12', label: 'Dec' },
];

function resolveMaxEnabledMonthForFixedYear(): number {
  const now = new Date();
  if (now.getFullYear() > FIXED_PERIOD_YEAR) {
    return 12;
  }
  if (now.getFullYear() < FIXED_PERIOD_YEAR) {
    return 1;
  }
  return now.getMonth() + 1;
}

function clampAnafPeriod(period: string): string {
  const maxEnabledMonth = resolveMaxEnabledMonthForFixedYear();
  const nowMonth = String(maxEnabledMonth).padStart(2, '0');
  const [_, monthPart = ''] = period.split('-');
  const monthNumber = Number(monthPart);

  if (!Number.isInteger(monthNumber)) {
    return `${FIXED_PERIOD_YEAR}-${nowMonth}`;
  }

  const normalizedMonth = Math.min(Math.max(monthNumber, 1), maxEnabledMonth);
  return `${FIXED_PERIOD_YEAR}-${String(normalizedMonth).padStart(2, '0')}`;
}

function resolvePeriodParts(period: string): { year: string; month: string } {
  const now = new Date();
  const defaultYear = String(now.getFullYear());
  const defaultMonth = String(now.getMonth() + 1).padStart(2, '0');
  const [yearPart = '', monthPart = ''] = period.split('-');

  const year = /^\d{4}$/.test(yearPart) ? yearPart : defaultYear;
  const month = /^\d{2}$/.test(monthPart) ? monthPart : defaultMonth;

  return { year, month };
}

function resolveLoginHints(): LoginHintCredentials[] {
  const adminEmail = (import.meta.env.VITE_LOGIN_HINT_ADMIN_EMAIL as string | undefined)?.trim() ?? '';
  const adminPassword = (import.meta.env.VITE_LOGIN_HINT_ADMIN_PASSWORD as string | undefined)?.trim() ?? '';
  const accountantLabel = (import.meta.env.VITE_LOGIN_HINT_ACCOUNTANT_LABEL as string | undefined)?.trim() || 'Contabil';
  const accountantEmail =
    (import.meta.env.VITE_LOGIN_HINT_ACCOUNTANT_EMAIL as string | undefined)?.trim() ??
    ((import.meta.env.VITE_LOGIN_HINT_USER_EMAIL as string | undefined)?.trim() ?? '');
  const accountantPassword =
    (import.meta.env.VITE_LOGIN_HINT_ACCOUNTANT_PASSWORD as string | undefined)?.trim() ??
    ((import.meta.env.VITE_LOGIN_HINT_USER_PASSWORD as string | undefined)?.trim() ?? '');

  const hints: LoginHintCredentials[] = [];

  if (adminEmail || adminPassword) {
    hints.push({
      label: 'Admin',
      email: adminEmail || 'n/a',
      password: adminPassword || 'n/a',
    });
  }

  if (accountantEmail || accountantPassword) {
    hints.push({
      label: accountantLabel,
      email: accountantEmail || 'n/a',
      password: accountantPassword || 'n/a',
    });
  }

  return hints;
}

const LOGIN_HINTS = resolveLoginHints();

function isMfaEnrollmentRequired(activeUser: User | null): boolean {
  if (!activeUser) {
    return false;
  }

  const activeRole = activeUser.companyRole ?? activeUser.role;
  return MFA_REQUIRED_ROLES.has(activeRole) && activeUser.mfaEnabled !== true;
}

function isCompanyOnboardingRequired(activeUser: User | null): boolean {
  return Boolean(activeUser && (activeUser.companyOnboardingRequired === true || !activeUser.companyId));
}

function App() {
  const { user, setSession, clearSession } = useAuthStorage();
  const [authInitialized, setAuthInitialized] = useState(false);

  const [moduleKey, setModuleKey] = useState<ModuleKey>('dashboard');
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string>('');
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [offlineWriteQueue, setOfflineWriteQueue] = useState<OfflineWriteOperation[]>(() => readOfflineWriteQueue());
  const [offlineSyncStatus, setOfflineSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle');
  const [offlineSyncMessage, setOfflineSyncMessage] = useState('');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [supplierInvoices, setSupplierInvoices] = useState<SupplierInvoice[]>([]);
  const [purchaseApprovers, setPurchaseApprovers] = useState<PurchaseApproverUser[]>([]);
  const [purchaseDelegations, setPurchaseDelegations] = useState<PurchaseApprovalDelegation[]>([]);
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);
  const [revisalExports, setRevisalExports] = useState<RevisalDelivery[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [trialBalance, setTrialBalance] = useState<TrialBalance | null>(null);
  const [pnl, setPnl] = useState<PnLReport | null>(null);
  const [balanceSheet, setBalanceSheet] = useState<BalanceSheet | null>(null);
  const [aging, setAging] = useState<AgingReport | null>(null);
  const [financialStatements, setFinancialStatements] = useState<FinancialStatements | null>(null);
  const [dashboardBi, setDashboardBi] = useState<DashboardBiReport | null>(null);
  const [purchasesDashboard, setPurchasesDashboard] = useState<PurchasesDashboard | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [anafInfo, setAnafInfo] = useState<string>('');

  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [loginForm, setLoginForm] = useState({ email: '', password: '', mfaCode: '' });
  const [registerForm, setRegisterForm] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [loginRequiresMfaCode, setLoginRequiresMfaCode] = useState(false);
  const [mfaSetupPayload, setMfaSetupPayload] = useState<MfaSetupPayload | null>(null);
  const [mfaVerificationCode, setMfaVerificationCode] = useState('');
  const [changePasswordForm, setChangePasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmNewPassword: '',
  });
  const [accountForm, setAccountForm] = useState({
    code: '',
    name: '',
    type: 'ASSET' as Account['type'],
    currency: 'RON',
  });
  const [partnerForm, setPartnerForm] = useState({
    name: '',
    type: 'BOTH' as Partner['type'],
    cui: '',
    iban: '',
    email: '',
    phone: '',
  });
  const [invoiceForm, setInvoiceForm] = useState({
    number: `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`,
    partnerId: '',
    dueDate: localDateTime(15),
    subtotal: '1000',
    vat: '190',
    description: '',
  });
  const [supplierInvoiceForm, setSupplierInvoiceForm] = useState({
    number: `AP-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`,
    supplierId: '',
    receivedDate: localDateTime(0),
    dueDate: localDateTime(15),
    subtotal: '1000',
    vat: '190',
    description: '',
  });
  const [purchaseDelegationForm, setPurchaseDelegationForm] = useState({
    fromUserId: '',
    toUserId: '',
    endsAt: localDateTime(7),
    reason: '',
  });
  const [stockItemForm, setStockItemForm] = useState({
    code: '',
    name: '',
    unit: 'BUC',
    valuationMethod: 'FIFO' as StockItem['valuationMethod'],
    minStockQty: '0',
    initialQuantity: '0',
    initialUnitCost: '',
  });
  const [nirForm, setNirForm] = useState({
    documentNumber: '',
    date: localDateTime(0),
    itemId: '',
    quantity: '1',
    unitCost: '0',
    note: '',
  });
  const [consumptionForm, setConsumptionForm] = useState({
    documentNumber: '',
    date: localDateTime(0),
    itemId: '',
    quantity: '1',
    note: '',
  });
  const [inventoryForm, setInventoryForm] = useState({
    documentNumber: '',
    date: localDateTime(0),
    itemId: '',
    countedQuantity: '0',
    unitCost: '',
    note: '',
  });
  const [journalForm, setJournalForm] = useState({
    description: '',
    lines: [
      { accountId: '', debit: '0', credit: '0', explanation: '' },
      { accountId: '', debit: '0', credit: '0', explanation: '' },
    ],
  });
  const [employeeForm, setEmployeeForm] = useState({
    cnp: '',
    name: '',
    contractType: 'CIM',
    grossSalary: '8000',
    personalDeduction: '0',
  });
  const [payrollForm, setPayrollForm] = useState({
    period: new Date().toISOString().slice(0, 7),
  });
  const [revisalGenerateForm, setRevisalGenerateForm] = useState({
    deliveryReference: '',
  });
  const [revisalDeliverForm, setRevisalDeliverForm] = useState<{
    exportId: string;
    channel: RevisalDeliveryChannel;
    receiptNumber: string;
    deliveredAt: string;
  }>({
    exportId: '',
    channel: 'WEB_PORTAL',
    receiptNumber: '',
    deliveredAt: localDateTime(0),
  });
  const [assetForm, setAssetForm] = useState({
    code: '',
    name: '',
    value: '24000',
    residualValue: '2000',
    depreciationMethod: 'LINEAR' as Asset['depreciationMethod'],
    usefulLifeMonths: '60',
    startDate: localDateTime(0),
  });
  const [depreciationForm, setDepreciationForm] = useState({
    period: new Date().toISOString().slice(0, 7),
  });
  const [anafPeriod, setAnafPeriod] = useState(() => clampAnafPeriod(''));
  const [purchasesDashboardFilter, setPurchasesDashboardFilter] = useState({
    asOf: new Date().toISOString().slice(0, 10),
    topSuppliers: '5',
  });
  const [dashboardBiFilter, setDashboardBiFilter] = useState({
    asOf: new Date().toISOString().slice(0, 10),
    dueSoonDays: '7',
    overdueGraceDays: '0',
    minAmount: '0',
    maxAlerts: '20',
  });
  const [paymentDialog, setPaymentDialog] = useState<PaymentDialogState | null>(null);
  const [paymentDialogError, setPaymentDialogError] = useState('');
  const [companyOnboardingForm, setCompanyOnboardingForm] = useState({
    code: '',
    name: '',
  });
  const moduleCacheRef = useRef<Partial<Record<ModuleKey, { key: string; loadedAt: number }>>>({});

  const { canRead, canAction, visibleMenuItems, visibleMenuKeys } = usePermissions(user);
  const availableCompanies = user?.availableCompanies ?? [];
  const periodParts = useMemo(() => resolvePeriodParts(anafPeriod), [anafPeriod]);
  const maxEnabledMonth = useMemo(() => resolveMaxEnabledMonthForFixedYear(), []);
  const showConnectivityBanner =
    !isOnline || offlineWriteQueue.length > 0 || offlineSyncStatus === 'syncing' || offlineSyncStatus === 'error';

  const stats = useMemo(() => {
    const openInvoices = invoices.filter((invoice) => invoice.status !== 'PAID').length;
    const receivables = invoices.reduce((sum, invoice) => {
      const paid = invoice.payments.reduce((acc, payment) => acc + toNum(payment.amount), 0);
      return sum + Math.max(toNum(invoice.total) - paid, 0);
    }, 0);

    return {
      accounts: accounts.length,
      partners: partners.length,
      openInvoices,
      receivables,
      journalEntries: journalEntries.length,
      employees: employees.length,
      assets: assets.length,
    };
  }, [accounts, employees, assets, invoices, journalEntries, partners]);

  const supplierPartners = useMemo(
    () => partners.filter((partner) => partner.type === 'SUPPLIER' || partner.type === 'BOTH'),
    [partners],
  );

  function buildPurchasesDashboardPath(asOf: string, topSuppliers: string): string {
    const params = new URLSearchParams();
    if (asOf) {
      params.set('asOf', asOf);
    }
    if (topSuppliers) {
      params.set('topSuppliers', topSuppliers);
    }

    const query = params.toString();
    return query ? `/purchases/dashboard?${query}` : '/purchases/dashboard';
  }

  function buildDashboardBiPath(filter: {
    asOf: string;
    dueSoonDays: string;
    overdueGraceDays: string;
    minAmount: string;
    maxAlerts: string;
  }): string {
    const params = new URLSearchParams();
    if (filter.asOf) {
      params.set('asOf', filter.asOf);
    }
    if (filter.dueSoonDays) {
      params.set('dueSoonDays', filter.dueSoonDays);
    }
    if (filter.overdueGraceDays) {
      params.set('overdueGraceDays', filter.overdueGraceDays);
    }
    if (filter.minAmount) {
      params.set('minAmount', filter.minAmount);
    }
    if (filter.maxAlerts) {
      params.set('maxAlerts', filter.maxAlerts);
    }

    const query = params.toString();
    return query ? `/reports/dashboard-bi?${query}` : '/reports/dashboard-bi';
  }

  async function fetchIfAllowed<T>(
    allowed: boolean,
    request: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    if (!allowed) {
      return fallback;
    }

    try {
      return await request();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        return fallback;
      }
      throw err;
    }
  }

  function openPaymentDialog(
    flow: PaymentDialogFlow,
    invoiceId: string,
    invoiceNumber: string,
    partnerName: string,
    openAmount: number,
  ): void {
    if (openAmount <= 0) {
      setError('Factura este deja stinsă integral.');
      return;
    }

    setPaymentDialogError('');
    setPaymentDialog({
      flow,
      invoiceId,
      invoiceNumber,
      partnerName,
      openAmount,
      amount: openAmount.toFixed(2),
      method: 'BANK_TRANSFER',
      reference: '',
      date: localDateTime(0),
      autoPost: true,
    });
  }

  function closePaymentDialog(): void {
    setPaymentDialog(null);
    setPaymentDialogError('');
  }

  function syncPartnerDependentForms(partnerData: Partner[]): void {
    setInvoiceForm((prev) => ({ ...prev, partnerId: partnerData[0]?.id ?? prev.partnerId }));

    const availableSupplierIds = new Set(
      partnerData
        .filter((partner) => partner.type === 'SUPPLIER' || partner.type === 'BOTH')
        .map((partner) => partner.id),
    );
    const fallbackSupplierId = partnerData.find(
      (partner) => partner.type === 'SUPPLIER' || partner.type === 'BOTH',
    )?.id;

    setSupplierInvoiceForm((prev) => ({
      ...prev,
      supplierId: availableSupplierIds.has(prev.supplierId) ? prev.supplierId : (fallbackSupplierId ?? ''),
    }));
  }

  function syncPurchaseDelegationForm(approverData: PurchaseApproverUser[]): void {
    const activeUserId = user?.id ?? '';
    setPurchaseDelegationForm((prev) => {
      const fallbackFromUserId = approverData.some((approver) => approver.id === activeUserId)
        ? activeUserId
        : (approverData[0]?.id ?? '');
      const resolvedFromUserId = prev.fromUserId || fallbackFromUserId;
      const fallbackToUserId = approverData.find((approver) => approver.id !== resolvedFromUserId)?.id ?? '';
      const resolvedToUserId =
        prev.toUserId && prev.toUserId !== resolvedFromUserId ? prev.toUserId : fallbackToUserId;

      return {
        ...prev,
        fromUserId: resolvedFromUserId,
        toUserId: resolvedToUserId,
      };
    });
  }

  function syncJournalDependentForms(accountData: Account[]): void {
    setJournalForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => ({
        ...line,
        accountId: line.accountId || accountData[0]?.id || '',
      })),
    }));
  }

  function syncStockDependentForms(stockData: StockItem[]): void {
    const fallbackItemId = stockData[0]?.id ?? '';
    setNirForm((prev) => ({
      ...prev,
      itemId: prev.itemId || fallbackItemId,
    }));
    setConsumptionForm((prev) => ({
      ...prev,
      itemId: prev.itemId || fallbackItemId,
    }));
    setInventoryForm((prev) => ({
      ...prev,
      itemId: prev.itemId || fallbackItemId,
      countedQuantity: prev.countedQuantity || '0',
    }));
  }

  function syncRevisalDependentForms(deliveryData: RevisalDelivery[]): void {
    const pendingDelivery = deliveryData.find((delivery) => delivery.status !== 'DELIVERED');
    setRevisalDeliverForm((prev) => {
      const hasCurrentSelection = deliveryData.some(
        (delivery) => delivery.id === prev.exportId && delivery.status !== 'DELIVERED',
      );

      return {
        ...prev,
        exportId: hasCurrentSelection ? prev.exportId : (pendingDelivery?.id ?? ''),
      };
    });
  }

  function cacheKeyForModule(targetModule: ModuleKey): string {
    const base = `${user?.companyId ?? 'no-company'}:${targetModule}`;
    if (targetModule === 'dashboard') {
      return `${base}:${purchasesDashboardFilter.asOf}:${purchasesDashboardFilter.topSuppliers}:${dashboardBiFilter.asOf}:${dashboardBiFilter.dueSoonDays}:${dashboardBiFilter.overdueGraceDays}:${dashboardBiFilter.minAmount}:${dashboardBiFilter.maxAlerts}`;
    }
    return base;
  }

  function isModuleCacheFresh(targetModule: ModuleKey): boolean {
    const entry = moduleCacheRef.current[targetModule];
    if (!entry) {
      return false;
    }

    if (entry.key !== cacheKeyForModule(targetModule)) {
      return false;
    }

    return Date.now() - entry.loadedAt < MODULE_CACHE_TTL_MS;
  }

  function markModuleLoaded(targetModule: ModuleKey): void {
    moduleCacheRef.current[targetModule] = {
      key: cacheKeyForModule(targetModule),
      loadedAt: Date.now(),
    };
  }

  function invalidateAllModuleCache(): void {
    moduleCacheRef.current = {};
  }

  async function loadModuleData(targetModule: ModuleKey, options: { force?: boolean } = {}): Promise<void> {
    if (!user) {
      return;
    }

    const force = options.force ?? false;
    if (!force && isModuleCacheFresh(targetModule)) {
      return;
    }

    setLoading(true);
    setError('');

    try {
      if (targetModule === 'dashboard') {
        const purchasesDashboardPath = buildPurchasesDashboardPath(
          purchasesDashboardFilter.asOf,
          purchasesDashboardFilter.topSuppliers,
        );
        const dashboardBiPath = buildDashboardBiPath(dashboardBiFilter);
        const [
          accountData,
          partnerData,
          invoiceData,
          employeeData,
          assetData,
          journalData,
          statementsData,
          purchasesDashboardData,
          dashboardBiData,
        ] = await Promise.all([
          fetchIfAllowed(canRead.accounts, () => apiRequest<Account[]>('/accounts'), []),
          fetchIfAllowed(canRead.partners, () => apiRequest<Partner[]>('/partners'), []),
          fetchIfAllowed(canRead.invoices, () => apiRequest<Invoice[]>('/invoices'), []),
          fetchIfAllowed(canRead.employees, () => apiRequest<Employee[]>('/employees'), []),
          fetchIfAllowed(canRead.assets, () => apiRequest<Asset[]>('/assets'), []),
          fetchIfAllowed(canRead.journal, () => apiRequest<JournalEntry[]>('/journal-entries'), []),
          fetchIfAllowed<FinancialStatements | null>(
            canRead.reports,
            () => apiRequest<FinancialStatements>('/reports/financial-statements'),
            null,
          ),
          fetchIfAllowed<PurchasesDashboard | null>(
            canRead.purchases,
            () => apiRequest<PurchasesDashboard>(purchasesDashboardPath),
            null,
          ),
          fetchIfAllowed<DashboardBiReport | null>(
            canRead.reports,
            () => apiRequest<DashboardBiReport>(dashboardBiPath),
            null,
          ),
        ]);

        setAccounts(accountData);
        setPartners(partnerData);
        setInvoices(invoiceData);
        setEmployees(employeeData);
        setAssets(assetData);
        setJournalEntries(journalData);
        setTrialBalance(statementsData?.trialBalance ?? null);
        setPnl(statementsData?.pnl ?? null);
        setBalanceSheet(statementsData?.balanceSheet ?? null);
        setAging(statementsData?.aging ?? null);
        setFinancialStatements(statementsData);
        setPurchasesDashboard(purchasesDashboardData);
        setDashboardBi(dashboardBiData);
        syncPartnerDependentForms(partnerData);
        syncJournalDependentForms(accountData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'admin') {
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'accounts') {
        const accountData = await fetchIfAllowed(canRead.accounts, () => apiRequest<Account[]>('/accounts'), []);
        setAccounts(accountData);
        syncJournalDependentForms(accountData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'journal') {
        const [accountData, journalData] = await Promise.all([
          fetchIfAllowed(canRead.accounts, () => apiRequest<Account[]>('/accounts'), []),
          fetchIfAllowed(canRead.journal, () => apiRequest<JournalEntry[]>('/journal-entries'), []),
        ]);
        setAccounts(accountData);
        setJournalEntries(journalData);
        syncJournalDependentForms(accountData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'partners') {
        const partnerData = await fetchIfAllowed(canRead.partners, () => apiRequest<Partner[]>('/partners'), []);
        setPartners(partnerData);
        syncPartnerDependentForms(partnerData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'invoices') {
        const [partnerData, invoiceData] = await Promise.all([
          fetchIfAllowed(canRead.partners, () => apiRequest<Partner[]>('/partners'), []),
          fetchIfAllowed(canRead.invoices, () => apiRequest<Invoice[]>('/invoices'), []),
        ]);
        setPartners(partnerData);
        setInvoices(invoiceData);
        syncPartnerDependentForms(partnerData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'purchases') {
        const [partnerData, supplierInvoiceData, approverData, delegationData] = await Promise.all([
          fetchIfAllowed(canRead.partners, () => apiRequest<Partner[]>('/partners'), []),
          fetchIfAllowed(canRead.purchases, () => apiRequest<SupplierInvoice[]>('/purchases/invoices'), []),
          fetchIfAllowed(
            canRead.purchases,
            () => apiRequest<PurchaseApproverUser[]>('/purchases/approvers'),
            [] as PurchaseApproverUser[],
          ),
          fetchIfAllowed(
            canRead.purchases,
            () => apiRequest<PurchaseApprovalDelegation[]>('/purchases/delegations'),
            [] as PurchaseApprovalDelegation[],
          ),
        ]);
        setPartners(partnerData);
        setSupplierInvoices(supplierInvoiceData);
        setPurchaseApprovers(approverData);
        setPurchaseDelegations(delegationData);
        syncPartnerDependentForms(partnerData);
        syncPurchaseDelegationForm(approverData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'stocks') {
        const [itemsData, movementsData] = await Promise.all([
          fetchIfAllowed(canRead.stocks, () => apiRequest<StockItem[]>('/stocks/items'), []),
          fetchIfAllowed(canRead.stocks, () => apiRequest<StockMovement[]>('/stocks/movements?take=160'), []),
        ]);
        setStockItems(itemsData);
        setStockMovements(movementsData);
        syncStockDependentForms(itemsData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'payroll') {
        const [employeeData, payrollData] = await Promise.all([
          fetchIfAllowed(canRead.employees, () => apiRequest<Employee[]>('/employees'), []),
          fetchIfAllowed(canRead.payroll, () => apiRequest<PayrollRun[]>('/payroll/runs'), []),
        ]);
        setEmployees(employeeData);
        setPayrollRuns(payrollData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'revisal') {
        const deliveryData = await fetchIfAllowed(
          canRead.payroll,
          () => apiRequest<RevisalDelivery[]>('/revisal/exports?limit=100'),
          [] as RevisalDelivery[],
        );
        setRevisalExports(deliveryData);
        syncRevisalDependentForms(deliveryData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'assets') {
        const assetData = await fetchIfAllowed(canRead.assets, () => apiRequest<Asset[]>('/assets'), []);
        setAssets(assetData);
        markModuleLoaded(targetModule);
        return;
      }

      if (targetModule === 'reports') {
        const statementsData = await fetchIfAllowed<FinancialStatements | null>(
          canRead.reports,
          () => apiRequest<FinancialStatements>('/reports/financial-statements'),
          null,
        );
        setTrialBalance(statementsData?.trialBalance ?? null);
        setPnl(statementsData?.pnl ?? null);
        setBalanceSheet(statementsData?.balanceSheet ?? null);
        setAging(statementsData?.aging ?? null);
        setFinancialStatements(statementsData);
        markModuleLoaded(targetModule);
        return;
      }

      const logs = await fetchIfAllowed(canRead.audit, () => apiRequest<AuditLog[]>('/audit-log?take=120'), [] as AuditLog[]);
      setAuditLogs(logs);
      markModuleLoaded(targetModule);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Nu s-au putut încărca datele.';
      setError(message);
      if (err instanceof ApiError && err.status === 401) {
        void handleLogout();
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function restoreSessionFromCookie(): Promise<void> {
      try {
        const response = await apiRequest<{ user: User }>('/auth/me');
        if (active) {
          setSession(response.user);
        }
      } catch {
        if (active) {
          clearSession();
        }
      } finally {
        if (active) {
          setAuthInitialized(true);
        }
      }
    }

    void restoreSessionFromCookie();

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setApiCompanyContext(user?.companyId ?? null);
  }, [user?.companyId]);

  useEffect(() => {
    function handleOnline(): void {
      setIsOnline(true);
      setOfflineSyncMessage((prev) => (prev ? prev : 'Conexiunea a fost restabilită.'));
    }

    function handleOffline(): void {
      setIsOnline(false);
      setOfflineSyncStatus('idle');
      setOfflineSyncMessage('Aplicația rulează offline. Operațiunile de scriere vor fi puse în coada locală.');
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    persistOfflineWriteQueue(offlineWriteQueue);
  }, [offlineWriteQueue]);

  useEffect(() => {
    if (!user) {
      return;
    }

    setOfflineWriteQueue((prev) => prev.filter((operation) => operation.userId === user.id));
  }, [user?.id]);

  useEffect(() => {
    if (!user || !isOnline || offlineWriteQueue.length === 0 || offlineSyncStatus === 'syncing') {
      return;
    }
    void syncOfflineWriteQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.companyId, isOnline, offlineWriteQueue.length, offlineSyncStatus]);

  useEffect(() => {
    invalidateAllModuleCache();
  }, [user?.id, user?.companyId]);

  useEffect(() => {
    const normalizedPeriod = clampAnafPeriod(anafPeriod);
    if (normalizedPeriod !== anafPeriod) {
      setAnafPeriod(normalizedPeriod);
    }
  }, [anafPeriod]);

  useEffect(() => {
    if (!isMfaEnrollmentRequired(user)) {
      setMfaSetupPayload(null);
      setMfaVerificationCode('');
    }
  }, [user]);

  useEffect(() => {
    if (
      authInitialized &&
      user &&
      !user.mustChangePassword &&
      !isMfaEnrollmentRequired(user) &&
      !isCompanyOnboardingRequired(user)
    ) {
      void loadModuleData(moduleKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authInitialized, user, moduleKey]);

  useEffect(() => {
    if (!visibleMenuKeys.has(moduleKey)) {
      const fallbackModule = visibleMenuItems[0]?.key ?? 'dashboard';
      setModuleKey(fallbackModule);
    }
  }, [moduleKey, visibleMenuItems, visibleMenuKeys]);

  function resetAuthForms(): void {
    setLoginForm({
      email: '',
      password: '',
      mfaCode: '',
    });
    setRegisterForm({
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
    });
    setLoginRequiresMfaCode(false);
  }

  async function handleLogin(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusyKey('login');
    setError('');
    setApiCompanyContext(null);

    try {
      const normalizedMfaCode = loginForm.mfaCode.trim();
      const response = await apiRequest<{ user: User }>('/auth/login', {
        method: 'POST',
        body: {
          email: loginForm.email,
          password: loginForm.password,
          ...(normalizedMfaCode.length > 0 ? { mfaCode: normalizedMfaCode } : {}),
        },
      });

      setSession(response.user);
      setLoginRequiresMfaCode(false);
      setAuthMode('login');
      setLoginForm((prev) => ({
        ...prev,
        password: '',
        mfaCode: '',
      }));
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'MFA_CODE_REQUIRED' || err.code === 'MFA_INVALID_CODE') {
          setLoginRequiresMfaCode(true);
        }
        setError(err.message);
      } else {
        setError(`Nu mă pot conecta la API (${API_BASE_URL}). Verifică backend-ul.`);
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRegister(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusyKey('register');
    setError('');
    setApiCompanyContext(null);

    if (registerForm.name.trim().length < 2) {
      setError('Numele trebuie să aibă cel puțin 2 caractere.');
      setBusyKey(null);
      return;
    }

    if (registerForm.password.length < 12) {
      setError('Parola trebuie să aibă cel puțin 12 caractere.');
      setBusyKey(null);
      return;
    }

    if (registerForm.password !== registerForm.confirmPassword) {
      setError('Confirmarea parolei nu coincide.');
      setBusyKey(null);
      return;
    }

    try {
      const response = await apiRequest<{ user: User }>('/auth/register', {
        method: 'POST',
        body: {
          name: registerForm.name,
          email: registerForm.email,
          password: registerForm.password,
        },
      });

      setSession(response.user);
      setAuthMode('login');
      resetAuthForms();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(`Nu mă pot conecta la API (${API_BASE_URL}). Verifică backend-ul.`);
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function generateMfaSetup(): Promise<void> {
    if (!user) {
      return;
    }

    setBusyKey('mfa-setup');
    setError('');

    try {
      const payload = await apiRequest<MfaSetupPayload>('/auth/mfa/setup', {
        method: 'POST',
        companyId: user.companyId,
      });
      setMfaSetupPayload(payload);
      setMfaVerificationCode('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut genera secretul MFA.');
    } finally {
      setBusyKey(null);
    }
  }

  async function verifyMfaSetup(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!user) {
      return;
    }

    const code = mfaVerificationCode.trim();
    if (code.length < 6) {
      setError('Codul MFA trebuie să aibă cel puțin 6 caractere.');
      return;
    }

    setBusyKey('mfa-verify');
    setError('');

    try {
      const response = await apiRequest<{ user: User }>('/auth/mfa/verify', {
        method: 'POST',
        companyId: user.companyId,
        body: { code },
      });
      setSession(response.user);
      setMfaSetupPayload(null);
      setMfaVerificationCode('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut valida codul MFA.');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleForcedPasswordChange(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusyKey('change-password');
    setError('');

    if (changePasswordForm.newPassword.length < 12) {
      setError('Noua parolă trebuie să aibă cel puțin 12 caractere.');
      setBusyKey(null);
      return;
    }

    if (changePasswordForm.newPassword !== changePasswordForm.confirmNewPassword) {
      setError('Confirmarea parolei nu coincide.');
      setBusyKey(null);
      return;
    }

    try {
      const response = await apiRequest<{ user: User }>('/auth/change-password', {
        method: 'POST',
        body: {
          currentPassword: changePasswordForm.currentPassword,
          newPassword: changePasswordForm.newPassword,
        },
      });

      setSession(response.user);
      setChangePasswordForm({
        currentPassword: '',
        newPassword: '',
        confirmNewPassword: '',
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut schimba parola.');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleLogout(): Promise<void> {
    try {
      await apiRequest('/auth/logout', {
        method: 'POST',
        skipAuthRefresh: true,
      });
    } catch {
      // Ignore logout API failures and clear client state.
    }
    setApiCompanyContext(null);
    invalidateAllModuleCache();
    setMfaSetupPayload(null);
    setMfaVerificationCode('');
    setCompanyOnboardingForm({
      code: '',
      name: '',
    });
    setAuthMode('login');
    resetAuthForms();
    setOfflineWriteQueue([]);
    setOfflineSyncStatus('idle');
    setOfflineSyncMessage('');
    clearSession();
  }

  async function refreshCurrentModuleAfterWrite(): Promise<void> {
    invalidateAllModuleCache();
    await loadModuleData(moduleKey, { force: true });
  }

  function enqueueOfflineWrite(params: {
    path: string;
    method: OfflineWriteMethod;
    body: unknown;
  }): WriteExecutionResult {
    if (!user) {
      throw new Error('Sesiunea utilizatorului nu este disponibilă pentru coada offline.');
    }

    const operation = buildOfflineWriteOperation({
      userId: user.id,
      companyId: user.companyId ?? null,
      path: params.path,
      method: params.method,
      body: params.body,
      moduleKey,
    });

    setOfflineWriteQueue((prev) => [...prev, operation]);
    setOfflineSyncMessage('Operațiunea a fost adăugată în coada locală și se va sincroniza la reconectare.');
    if (offlineSyncStatus !== 'syncing') {
      setOfflineSyncStatus('idle');
    }
    return { queued: true };
  }

  async function submitWriteOrQueue(
    path: string,
    body: unknown,
    method: OfflineWriteMethod = 'POST',
  ): Promise<WriteExecutionResult> {
    if (!user) {
      throw new Error('Sesiunea utilizatorului nu este disponibilă.');
    }

    if (!isOnline) {
      return enqueueOfflineWrite({ path, method, body });
    }

    try {
      await apiRequest(path, {
        method,
        body,
        companyId: user.companyId,
      });
      return { queued: false };
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      return enqueueOfflineWrite({ path, method, body });
    }
  }

  async function syncOfflineWriteQueue(options: { manual?: boolean } = {}): Promise<void> {
    if (!user) {
      return;
    }

    if (!isOnline) {
      if (options.manual) {
        setOfflineSyncStatus('error');
        setOfflineSyncMessage('Sincronizarea nu poate porni cât timp aplicația este offline.');
      }
      return;
    }

    if (offlineSyncStatus === 'syncing') {
      return;
    }

    const queueForUser = offlineWriteQueue.filter((operation) => operation.userId === user.id);
    if (queueForUser.length === 0) {
      setOfflineSyncStatus('idle');
      if (options.manual) {
        setOfflineSyncMessage('Coada locală este goală.');
      }
      return;
    }

    setOfflineSyncStatus('syncing');
    setOfflineSyncMessage('');

    let processed = 0;

    for (const operation of queueForUser) {
      try {
        await apiRequest(operation.path, {
          method: operation.method,
          body: operation.body,
          companyId: operation.companyId,
        });
        processed += 1;
        setOfflineWriteQueue((prev) => prev.filter((item) => item.id !== operation.id));
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Eroare de conectivitate în timpul sincronizării.';
        setOfflineSyncStatus('error');
        setOfflineSyncMessage(message);
        setError(`Sincronizarea cozii offline a fost oprită: ${message}`);
        return;
      }
    }

    setOfflineSyncStatus('idle');
    setOfflineSyncMessage(`Sincronizare finalizată: ${processed} operațiuni aplicate.`);
    if (processed > 0) {
      await refreshCurrentModuleAfterWrite();
    }
  }

  function handleSidebarMonthChange(nextMonth: string): void {
    const nextPeriod = clampAnafPeriod(`${FIXED_PERIOD_YEAR}-${nextMonth}`);
    setAnafPeriod(nextPeriod);
    void loadModuleData(moduleKey, { force: true });
  }

  async function switchCompany(nextCompanyId: string): Promise<void> {
    if (!user || !nextCompanyId || nextCompanyId === user.companyId) {
      return;
    }

    setBusyKey('switch-company');
    setError('');

    try {
      const response = await apiRequest<{ user: User }>('/auth/switch-company', {
        method: 'POST',
        body: {
          companyId: nextCompanyId,
          makeDefault: true,
        },
      });
      setSession(response.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut schimba compania activă.');
    } finally {
      setBusyKey(null);
    }
  }

  async function selectCompanyDuringOnboarding(companyId: string): Promise<void> {
    if (!companyId) {
      setError('Selectează o firmă validă.');
      return;
    }

    setBusyKey('onboarding-select-company');
    setError('');
    try {
      const response = await apiRequest<{ user: User }>('/auth/switch-company', {
        method: 'POST',
        body: {
          companyId,
          makeDefault: true,
        },
      });
      setSession(response.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut selecta firma.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createCompanyDuringOnboarding(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!user) {
      return;
    }

    const normalizedCode = companyOnboardingForm.code.trim().toUpperCase();
    const normalizedName = companyOnboardingForm.name.trim();

    if (normalizedCode.length < 2) {
      setError('Codul firmei trebuie să aibă cel puțin 2 caractere.');
      return;
    }

    if (!/^[A-Z0-9._-]+$/.test(normalizedCode)) {
      setError('Codul firmei poate conține doar litere, cifre, punct, underscore și minus.');
      return;
    }

    if (normalizedName.length < 2) {
      setError('Denumirea firmei trebuie să aibă cel puțin 2 caractere.');
      return;
    }

    setBusyKey('onboarding-create-company');
    setError('');

    try {
      const response = await apiRequest<{ user: User }>('/auth/companies', {
        method: 'POST',
        body: {
          code: normalizedCode,
          name: normalizedName,
        },
      });
      setSession(response.user);
      setCompanyOnboardingForm({
        code: '',
        name: '',
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut crea firma.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createAccount(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.createAccount) {
      setError('Nu ai permisiunea de a crea conturi.');
      return;
    }
    setBusyKey('account');
    setError('');

    try {
      const result = await submitWriteOrQueue('/accounts', accountForm);

      setAccountForm({ code: '', name: '', type: 'ASSET', currency: 'RON' });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut crea contul.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createPartner(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.createPartner) {
      setError('Nu ai permisiunea de a crea parteneri.');
      return;
    }
    setBusyKey('partner');
    setError('');

    try {
      const result = await submitWriteOrQueue('/partners', {
        ...partnerForm,
        cui: partnerForm.cui || undefined,
        iban: partnerForm.iban || undefined,
        email: partnerForm.email || undefined,
        phone: partnerForm.phone || undefined,
      });
      setPartnerForm({ name: '', type: 'BOTH', cui: '', iban: '', email: '', phone: '' });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut crea partenerul.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createEmployee(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.createEmployee) {
      setError('Nu ai permisiunea de a crea angajați.');
      return;
    }
    setBusyKey('employee');
    setError('');

    try {
      const result = await submitWriteOrQueue('/employees', {
        ...employeeForm,
        grossSalary: Number(employeeForm.grossSalary),
        personalDeduction: Number(employeeForm.personalDeduction),
      });

      setEmployeeForm({
        cnp: '',
        name: '',
        contractType: 'CIM',
        grossSalary: '8000',
        personalDeduction: '0',
      });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut crea angajatul.');
    } finally {
      setBusyKey(null);
    }
  }

  async function runPayroll(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.runPayroll) {
      setError('Nu ai permisiunea de a genera state de salarii.');
      return;
    }
    setBusyKey('payroll');
    setError('');

    try {
      const result = await submitWriteOrQueue('/payroll/runs/generate', {
        period: payrollForm.period,
        autoPost: true,
      });

      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut genera statul de salarii.');
    } finally {
      setBusyKey(null);
    }
  }

  async function generateRevisalExport(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.runPayroll) {
      setError('Nu ai permisiunea de a genera exporturi Revisal.');
      return;
    }

    if (!anafPeriod) {
      setError('Perioada pentru export Revisal este obligatorie.');
      return;
    }

    setBusyKey('revisal-generate');
    setError('');

    try {
      const result = await submitWriteOrQueue('/revisal/exports', {
        period: anafPeriod,
        deliveryReference: revisalGenerateForm.deliveryReference.trim() || undefined,
        reason: 'manual-ui-export',
      });

      setRevisalGenerateForm((prev) => ({
        ...prev,
        deliveryReference: '',
      }));
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut genera exportul Revisal.');
    } finally {
      setBusyKey(null);
    }
  }

  async function markRevisalDelivered(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.runPayroll) {
      setError('Nu ai permisiunea de a confirma livrarea Revisal.');
      return;
    }

    if (!revisalDeliverForm.exportId) {
      setError('Selectează un export Revisal pentru confirmare.');
      return;
    }

    if (revisalDeliverForm.channel === 'WEB_PORTAL' && revisalDeliverForm.receiptNumber.trim().length < 2) {
      setError('Numărul recipisei este obligatoriu pentru canalul WEB_PORTAL.');
      return;
    }

    setBusyKey('revisal-deliver');
    setError('');

    try {
      const result = await submitWriteOrQueue(`/revisal/exports/${revisalDeliverForm.exportId}/deliver`, {
        channel: revisalDeliverForm.channel,
        deliveredAt: revisalDeliverForm.deliveredAt
          ? new Date(revisalDeliverForm.deliveredAt).toISOString()
          : undefined,
        receiptNumber: revisalDeliverForm.receiptNumber.trim() || undefined,
        reason: 'manual-ui-delivery-confirm',
      });

      setRevisalDeliverForm((prev) => ({
        ...prev,
        receiptNumber: '',
      }));
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut confirma livrarea Revisal.');
    } finally {
      setBusyKey(null);
    }
  }

  async function downloadRevisalXml(delivery: RevisalDelivery): Promise<void> {
    setBusyKey(`revisal-download-${delivery.id}`);
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/revisal/exports/${delivery.id}/xml`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Descărcarea XML Revisal a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Keep fallback message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
      const fallbackName = `revisal-${delivery.period}.xml`;
      const filename = filenameMatch?.[1] ?? fallbackName;

      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nu s-a putut descărca XML Revisal.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createAsset(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.createAsset) {
      setError('Nu ai permisiunea de a crea mijloace fixe.');
      return;
    }
    setBusyKey('asset');
    setError('');

    try {
      const result = await submitWriteOrQueue('/assets', {
        code: assetForm.code || undefined,
        name: assetForm.name,
        value: Number(assetForm.value),
        residualValue: Number(assetForm.residualValue),
        depreciationMethod: assetForm.depreciationMethod,
        startDate: new Date(assetForm.startDate).toISOString(),
        usefulLifeMonths: Number(assetForm.usefulLifeMonths),
      });

      setAssetForm({
        code: '',
        name: '',
        value: '24000',
        residualValue: '2000',
        depreciationMethod: 'LINEAR',
        usefulLifeMonths: '60',
        startDate: localDateTime(0),
      });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut crea mijlocul fix.');
    } finally {
      setBusyKey(null);
    }
  }

  async function runDepreciation(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.runDepreciation) {
      setError('Nu ai permisiunea de a rula amortizarea.');
      return;
    }
    setBusyKey('depreciation');
    setError('');

    try {
      const result = await submitWriteOrQueue('/assets/run-depreciation', {
        period: depreciationForm.period,
        autoPost: true,
      });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut rula amortizarea.');
    } finally {
      setBusyKey(null);
    }
  }

  async function downloadFinancialExport(format: 'pdf' | 'excel' | 'xml'): Promise<void> {
    if (!canAction.exportReports) {
      setError('Nu ai permisiunea de export rapoarte.');
      return;
    }
    setBusyKey(`export-${format}`);
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/reports/export/financial.${format}`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = `Export ${format.toUpperCase()} eșuat.`;
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON errors and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
      const fallbackName = `situatii-financiare.${format === 'excel' ? 'csv' : format}`;
      const filename = filenameMatch?.[1] ?? fallbackName;

      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Exportul a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openAccountsListPdf(): Promise<void> {
    if (!canRead.accounts) {
      setError('Nu ai permisiunea de vizualizare pentru planul de conturi.');
      return;
    }

    setBusyKey('accounts-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/accounts/export/pdf`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea listei de conturi a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] ?? `plan-conturi-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea listei de conturi a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openJournalEntriesListPdf(): Promise<void> {
    if (!canRead.journal) {
      setError('Nu ai permisiunea de vizualizare pentru notele contabile.');
      return;
    }

    setBusyKey('journal-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/journal-entries/export/pdf`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea listei de note contabile a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] ?? `note-contabile-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea listei de note contabile a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openPartnersListPdf(): Promise<void> {
    if (!canRead.partners) {
      setError('Nu ai permisiunea de vizualizare pentru parteneri.');
      return;
    }

    setBusyKey('partners-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/partners/export/pdf`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea listei de parteneri a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] ?? `parteneri-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea listei de parteneri a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openInvoicesListPdf(): Promise<void> {
    if (!canRead.invoices) {
      setError('Nu ai permisiunea de vizualizare pentru facturi și încasări.');
      return;
    }

    setBusyKey('invoices-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/invoices/export/pdf`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea listei de facturi și încasări a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] ?? `facturi-incasari-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea listei de facturi și încasări a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openPurchasesListPdf(): Promise<void> {
    if (!canRead.purchases) {
      setError('Nu ai permisiunea de vizualizare pentru facturi furnizori și plăți.');
      return;
    }

    setBusyKey('purchases-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/purchases/invoices/export/pdf`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea listei de facturi furnizori și plăți a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] ?? `facturi-furnizori-plati-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea listei de facturi furnizori și plăți a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openStocksListPdf(): Promise<void> {
    if (!canRead.stocks) {
      setError('Nu ai permisiunea de vizualizare pentru stocuri.');
      return;
    }

    setBusyKey('stocks-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/stocks/export/pdf`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea listelor de stocuri a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = filenameMatch?.[1] ?? `stocuri-miscari-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea listelor de stocuri a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openPayrollEmployeesListPdf(): Promise<void> {
    if (!canRead.payroll) {
      setError('Nu ai permisiunea de vizualizare pentru angajați.');
      return;
    }

    setBusyKey('payroll-employees-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/payroll/export/employees/pdf`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea listei de angajați a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = filenameMatch?.[1] ?? `angajati-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea listei de angajați a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openPayrollRunsListPdf(): Promise<void> {
    if (!canRead.payroll) {
      setError('Nu ai permisiunea de vizualizare pentru state.');
      return;
    }

    setBusyKey('payroll-runs-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/payroll/export/runs/pdf`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea listei de state a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = filenameMatch?.[1] ?? `state-salarii-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea listei de state a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openRevisalExportsListPdf(): Promise<void> {
    if (!canRead.payroll) {
      setError('Nu ai permisiunea de vizualizare pentru exporturile Revisal.');
      return;
    }

    setBusyKey('revisal-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/revisal/exports/pdf?limit=100`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea listei de exporturi Revisal a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = filenameMatch?.[1] ?? `exporturi-revisal-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea listei de exporturi Revisal a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function openAssetsListPdf(): Promise<void> {
    if (!canRead.assets) {
      setError('Nu ai permisiunea de vizualizare pentru mijloace fixe.');
      return;
    }

    setBusyKey('assets-list-pdf');
    setError('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(`${API_BASE_URL}/assets/export/pdf`, {
        credentials: 'include',
        headers,
      });

      if (!response.ok) {
        let message = 'Generarea registrului de mijloace fixe a eșuat.';
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Ignore non-JSON responses and keep default message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') ?? '';
      const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = filenameMatch?.[1] ?? `registru-mijloace-fixe-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.setTimeout(() => {
        window.URL.revokeObjectURL(url);
      }, 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generarea registrului de mijloace fixe a eșuat.');
    } finally {
      setBusyKey(null);
    }
  }

  async function downloadAnafExport(
    type: 'd300' | 'd394' | 'd112' | 'd101' | 'd100' | 'd205' | 'd392' | 'd393' | 'd406',
  ): Promise<void> {
    if (!canAction.exportReports) {
      setError('Nu ai permisiunea de export rapoarte.');
      return;
    }
    setBusyKey(`export-${type}`);
    setError('');
    setAnafInfo('');

    try {
      const headers = user?.companyId ? { 'x-company-id': user.companyId } : undefined;
      const response = await fetch(
        `${API_BASE_URL}/reports/export/anaf/${type}.xml?period=${encodeURIComponent(anafPeriod)}&validate=true`,
        {
          credentials: 'include',
          headers,
        },
      );

      if (!response.ok) {
        let message = `Export ANAF ${type.toUpperCase()} eșuat.`;
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) {
            message = payload.message;
          }
        } catch {
          // Keep fallback message.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const profileValid = response.headers.get('x-anaf-profile-valid');
      const xsdPerformed = response.headers.get('x-anaf-xsd-performed');
      const xsdValid = response.headers.get('x-anaf-xsd-valid');
      const declaration = response.headers.get('x-anaf-declaration') ?? type.toUpperCase();
      const infoParts = [
        `${declaration}: profil=${profileValid ?? 'unknown'}`,
        `xsdPerformed=${xsdPerformed ?? 'unknown'}`,
        `xsdValid=${xsdValid ?? 'unknown'}`,
      ];
      setAnafInfo(infoParts.join(' | '));

      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${type.toUpperCase()}-${anafPeriod}.xml`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Export ANAF ${type.toUpperCase()} eșuat.`);
    } finally {
      setBusyKey(null);
    }
  }

  async function checkAnafValidation(): Promise<void> {
    if (!canAction.exportReports) {
      setError('Nu ai permisiunea de export rapoarte.');
      return;
    }
    setBusyKey('export-anaf-check');
    setError('');
    setAnafInfo('');

    try {
      const response = await apiRequest<{
        generatedAt: string;
        period: string;
        results: Array<{
          declaration: string;
          profile: { valid: boolean };
          xsd: { performed: boolean; valid: boolean | null };
        }>;
      }>(`/reports/export/anaf/validation?period=${encodeURIComponent(anafPeriod)}&validate=true`);

      const summary = response.results
        .map((item) => `${item.declaration}: profile=${item.profile.valid} xsd=${item.xsd.valid ?? 'n/a'}`)
        .join(' | ');
      setAnafInfo(summary);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut verifica validarea ANAF.');
    } finally {
      setBusyKey(null);
    }
  }

  async function applyPurchasesDashboardFilter(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canRead.purchases) {
      setError('Nu ai permisiunea de a vizualiza dashboard-ul de achiziții.');
      return;
    }
    setBusyKey('purchases-dashboard');
    setError('');

    const topSuppliers = Number(purchasesDashboardFilter.topSuppliers);
    if (!Number.isInteger(topSuppliers) || topSuppliers < 1 || topSuppliers > 20) {
      setError('Top furnizori trebuie să fie un număr întreg între 1 și 20.');
      setBusyKey(null);
      return;
    }

    if (!purchasesDashboardFilter.asOf) {
      setError('Data asOf este obligatorie.');
      setBusyKey(null);
      return;
    }

    try {
      const dashboardData = await apiRequest<PurchasesDashboard>(
        buildPurchasesDashboardPath(purchasesDashboardFilter.asOf, purchasesDashboardFilter.topSuppliers),
      );
      setPurchasesDashboard(dashboardData);
      markModuleLoaded('dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut actualiza dashboard-ul AP.');
    } finally {
      setBusyKey(null);
    }
  }

  async function applyDashboardBiFilter(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canRead.reports) {
      setError('Nu ai permisiunea de a vizualiza dashboard-ul BI.');
      return;
    }

    setBusyKey('dashboard-bi');
    setError('');

    const dueSoonDays = Number(dashboardBiFilter.dueSoonDays);
    const overdueGraceDays = Number(dashboardBiFilter.overdueGraceDays);
    const minAmount = Number(dashboardBiFilter.minAmount);
    const maxAlerts = Number(dashboardBiFilter.maxAlerts);

    if (!dashboardBiFilter.asOf) {
      setError('Data asOf este obligatorie pentru dashboard-ul BI.');
      setBusyKey(null);
      return;
    }

    if (!Number.isInteger(dueSoonDays) || dueSoonDays < 1 || dueSoonDays > 90) {
      setError('Pragul de scadență trebuie să fie un număr întreg între 1 și 90.');
      setBusyKey(null);
      return;
    }

    if (!Number.isInteger(overdueGraceDays) || overdueGraceDays < 0 || overdueGraceDays > 90) {
      setError('Grace pentru restante trebuie să fie un număr întreg între 0 și 90.');
      setBusyKey(null);
      return;
    }

    if (!Number.isFinite(minAmount) || minAmount < 0 || minAmount > 1_000_000_000) {
      setError('Suma minimă alertă trebuie să fie între 0 și 1.000.000.000.');
      setBusyKey(null);
      return;
    }

    if (!Number.isInteger(maxAlerts) || maxAlerts < 1 || maxAlerts > 100) {
      setError('Numărul maxim de alerte trebuie să fie un număr întreg între 1 și 100.');
      setBusyKey(null);
      return;
    }

    try {
      const biData = await apiRequest<DashboardBiReport>(buildDashboardBiPath(dashboardBiFilter));
      setDashboardBi(biData);
      markModuleLoaded('dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut actualiza dashboard-ul BI.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createJournalEntry(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.createJournalEntry) {
      setError('Nu ai permisiunea de a posta note contabile.');
      return;
    }
    setBusyKey('journal');
    setError('');

    const lines = journalForm.lines.map((line) => ({
      accountId: line.accountId,
      debit: Number(line.debit),
      credit: Number(line.credit),
      explanation: line.explanation || undefined,
    }));

    try {
      const result = await submitWriteOrQueue('/journal-entries', {
        description: journalForm.description,
        lines,
        sourceModule: 'GENERAL_LEDGER',
      });

      setJournalForm({
        description: '',
        lines: [
          { accountId: accounts[0]?.id ?? '', debit: '0', credit: '0', explanation: '' },
          { accountId: accounts[0]?.id ?? '', debit: '0', credit: '0', explanation: '' },
        ],
      });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut salva nota contabilă.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createInvoice(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.createInvoice) {
      setError('Nu ai permisiunea de a emite facturi.');
      return;
    }
    setBusyKey('invoice');
    setError('');

    try {
      const result = await submitWriteOrQueue('/invoices', {
        number: invoiceForm.number,
        partnerId: invoiceForm.partnerId,
        dueDate: new Date(invoiceForm.dueDate).toISOString(),
        subtotal: Number(invoiceForm.subtotal),
        vat: Number(invoiceForm.vat),
        description: invoiceForm.description || undefined,
        autoPost: true,
      });

      setInvoiceForm({
        number: `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`,
        partnerId: partners[0]?.id ?? '',
        dueDate: localDateTime(15),
        subtotal: '1000',
        vat: '190',
        description: '',
      });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut crea factura.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createSupplierInvoice(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.createSupplierInvoice) {
      setError('Nu ai permisiunea de a înregistra facturi de furnizor.');
      return;
    }
    setBusyKey('supplier-invoice');
    setError('');

    try {
      const result = await submitWriteOrQueue('/purchases/invoices', {
        number: supplierInvoiceForm.number,
        supplierId: supplierInvoiceForm.supplierId,
        receivedDate: new Date(supplierInvoiceForm.receivedDate).toISOString(),
        dueDate: new Date(supplierInvoiceForm.dueDate).toISOString(),
        subtotal: Number(supplierInvoiceForm.subtotal),
        vat: Number(supplierInvoiceForm.vat),
        description: supplierInvoiceForm.description || undefined,
        autoPost: true,
      });

      setSupplierInvoiceForm({
        number: `AP-${new Date().getFullYear()}-${String(Date.now()).slice(-5)}`,
        supplierId: supplierPartners[0]?.id ?? '',
        receivedDate: localDateTime(0),
        dueDate: localDateTime(15),
        subtotal: '1000',
        vat: '190',
        description: '',
      });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut crea factura de furnizor.');
    } finally {
      setBusyKey(null);
    }
  }

  async function approveSupplierInvoice(invoice: SupplierInvoice, channel: 'WEB' | 'MOBILE'): Promise<void> {
    if (!canAction.approveSupplierInvoice) {
      setError('Nu ai permisiunea de a aproba facturi furnizor.');
      return;
    }

    const note = window.prompt(
      channel === 'MOBILE'
        ? `Observații aprobare mobilă pentru ${invoice.number} (opțional):`
        : `Observații aprobare pentru ${invoice.number} (opțional):`,
      '',
    );
    if (note === null) {
      return;
    }

    const busyToken = channel === 'MOBILE' ? 'supplier-approve-mobile' : 'supplier-approve';
    setBusyKey(busyToken);
    setError('');

    try {
      const endpoint =
        channel === 'MOBILE'
          ? `/purchases/invoices/${invoice.id}/approve/mobile`
          : `/purchases/invoices/${invoice.id}/approve`;
      const result = await submitWriteOrQueue(endpoint, {
        note: note.trim().length > 0 ? note.trim() : undefined,
      });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut aproba factura furnizor.');
    } finally {
      setBusyKey(null);
    }
  }

  async function rejectSupplierInvoice(invoice: SupplierInvoice): Promise<void> {
    if (!canAction.rejectSupplierInvoice) {
      setError('Nu ai permisiunea de a respinge facturi furnizor.');
      return;
    }

    const reason = window.prompt(`Motiv respingere pentru ${invoice.number}:`, invoice.approvalRejectedReason ?? '');
    if (reason === null) {
      return;
    }
    if (reason.trim().length < 5) {
      setError('Motivul respingerii trebuie să conțină cel puțin 5 caractere.');
      return;
    }

    setBusyKey('supplier-reject');
    setError('');
    try {
      const result = await submitWriteOrQueue(`/purchases/invoices/${invoice.id}/reject`, {
        reason: reason.trim(),
      });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut respinge factura furnizor.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createPurchaseDelegation(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.delegateSupplierInvoiceApproval) {
      setError('Nu ai permisiunea de a delega aprobări AP.');
      return;
    }

    if (!purchaseDelegationForm.toUserId) {
      setError('Selectează utilizatorul delegat.');
      return;
    }

    setBusyKey('purchase-delegation');
    setError('');
    try {
      const result = await submitWriteOrQueue('/purchases/delegations', {
        fromUserId: purchaseDelegationForm.fromUserId || undefined,
        toUserId: purchaseDelegationForm.toUserId,
        endsAt: new Date(purchaseDelegationForm.endsAt).toISOString(),
        reason: purchaseDelegationForm.reason || undefined,
      });

      setPurchaseDelegationForm((prev) => ({
        ...prev,
        toUserId: purchaseApprovers.find((approver) => approver.id !== (prev.fromUserId || user?.id))?.id ?? '',
        endsAt: localDateTime(7),
        reason: '',
      }));
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut crea delegarea de aprobare.');
    } finally {
      setBusyKey(null);
    }
  }

  async function createStockItem(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.createStockItem) {
      setError('Nu ai permisiunea de a crea articole de stoc.');
      return;
    }
    setBusyKey('stock-item');
    setError('');

    try {
      const result = await submitWriteOrQueue('/stocks/items', {
        code: stockItemForm.code,
        name: stockItemForm.name,
        unit: stockItemForm.unit,
        valuationMethod: stockItemForm.valuationMethod,
        minStockQty: Number(stockItemForm.minStockQty),
        initialQuantity: Number(stockItemForm.initialQuantity),
        initialUnitCost:
          stockItemForm.initialUnitCost.trim().length > 0 ? Number(stockItemForm.initialUnitCost) : undefined,
      });

      setStockItemForm({
        code: '',
        name: '',
        unit: 'BUC',
        valuationMethod: 'FIFO',
        minStockQty: '0',
        initialQuantity: '0',
        initialUnitCost: '',
      });
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut crea articolul de stoc.');
    } finally {
      setBusyKey(null);
    }
  }

  async function registerNir(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.registerNir) {
      setError('Nu ai permisiunea de a înregistra NIR.');
      return;
    }
    setBusyKey('stock-nir');
    setError('');

    try {
      const result = await submitWriteOrQueue('/stocks/nir', {
        date: new Date(nirForm.date).toISOString(),
        documentNumber: nirForm.documentNumber || undefined,
        lines: [
          {
            itemId: nirForm.itemId,
            quantity: Number(nirForm.quantity),
            unitCost: Number(nirForm.unitCost),
            note: nirForm.note || undefined,
          },
        ],
      });

      setNirForm((prev) => ({
        ...prev,
        documentNumber: '',
        quantity: '1',
        unitCost: '0',
        note: '',
      }));
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut înregistra NIR-ul.');
    } finally {
      setBusyKey(null);
    }
  }

  async function registerStockConsumption(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.registerStockConsumption) {
      setError('Nu ai permisiunea de a înregistra consum de stoc.');
      return;
    }
    setBusyKey('stock-consumption');
    setError('');

    try {
      const result = await submitWriteOrQueue('/stocks/consumptions', {
        date: new Date(consumptionForm.date).toISOString(),
        documentNumber: consumptionForm.documentNumber || undefined,
        lines: [
          {
            itemId: consumptionForm.itemId,
            quantity: Number(consumptionForm.quantity),
            note: consumptionForm.note || undefined,
          },
        ],
      });

      setConsumptionForm((prev) => ({
        ...prev,
        documentNumber: '',
        quantity: '1',
        note: '',
      }));
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut înregistra consumul.');
    } finally {
      setBusyKey(null);
    }
  }

  async function reconcileStockInventory(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canAction.reconcileStockInventory) {
      setError('Nu ai permisiunea de a face regularizări de inventar.');
      return;
    }
    setBusyKey('stock-inventory');
    setError('');

    try {
      const result = await submitWriteOrQueue('/stocks/inventory', {
        date: new Date(inventoryForm.date).toISOString(),
        documentNumber: inventoryForm.documentNumber || undefined,
        lines: [
          {
            itemId: inventoryForm.itemId,
            countedQuantity: Number(inventoryForm.countedQuantity),
            unitCost: inventoryForm.unitCost.trim().length > 0 ? Number(inventoryForm.unitCost) : undefined,
            note: inventoryForm.note || undefined,
          },
        ],
      });

      setInventoryForm((prev) => ({
        ...prev,
        documentNumber: '',
        countedQuantity: '0',
        unitCost: '',
        note: '',
      }));
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nu s-a putut aplica inventarul.');
    } finally {
      setBusyKey(null);
    }
  }

  function collectInvoice(invoice: Invoice): void {
    if (!canAction.collectInvoice) {
      setError('Nu ai permisiunea de a înregistra încasări.');
      return;
    }
    const paid = invoice.payments.reduce((acc, payment) => acc + toNum(payment.amount), 0);
    const openAmount = Math.max(toNum(invoice.total) - paid, 0);
    openPaymentDialog('INVOICE_COLLECTION', invoice.id, invoice.number, invoice.partner.name, openAmount);
  }

  function paySupplierInvoice(invoice: SupplierInvoice): void {
    if (!canAction.paySupplierInvoice) {
      setError('Nu ai permisiunea de a înregistra plăți furnizor.');
      return;
    }
    const paid = invoice.payments.reduce((acc, payment) => acc + toNum(payment.amount), 0);
    const openAmount = Math.max(toNum(invoice.total) - paid, 0);
    openPaymentDialog('SUPPLIER_PAYMENT', invoice.id, invoice.number, invoice.supplier.name, openAmount);
  }

  async function submitPaymentDialog(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const dialog = paymentDialog;
    if (!dialog) {
      return;
    }

    if (dialog.flow === 'INVOICE_COLLECTION' && !canAction.collectInvoice) {
      setPaymentDialogError('Nu ai permisiunea de a înregistra încasări.');
      return;
    }

    if (dialog.flow === 'SUPPLIER_PAYMENT' && !canAction.paySupplierInvoice) {
      setPaymentDialogError('Nu ai permisiunea de a înregistra plăți furnizor.');
      return;
    }

    const amount = Number(dialog.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPaymentDialogError('Suma introdusă este invalidă.');
      return;
    }

    if (amount > dialog.openAmount) {
      setPaymentDialogError(`Suma nu poate depăși soldul deschis (${fmtCurrency(dialog.openAmount)}).`);
      return;
    }

    if (!dialog.date) {
      setPaymentDialogError('Data plății/încasării este obligatorie.');
      return;
    }

    setBusyKey('payment-dialog-submit');
    setPaymentDialogError('');
    setError('');

    try {
      const endpoint =
        dialog.flow === 'INVOICE_COLLECTION' ? `/invoices/${dialog.invoiceId}/pay` : `/purchases/invoices/${dialog.invoiceId}/pay`;

      const result = await submitWriteOrQueue(endpoint, {
        amount,
        method: dialog.method,
        reference: dialog.reference || undefined,
        date: new Date(dialog.date).toISOString(),
        autoPost: dialog.autoPost,
      });

      closePaymentDialog();
      if (!result.queued) {
        await refreshCurrentModuleAfterWrite();
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Nu s-a putut procesa plata.';
      setPaymentDialogError(message);
      setError(message);
    } finally {
      setBusyKey(null);
    }
  }

  if (!authInitialized) {
    return (
      <main className="login-wrap">
        <section className="login-card">
          <h1>SEGA Accounting Suite</h1>
          <p>Se inițializează sesiunea...</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        mode={authMode}
        name={registerForm.name}
        email={authMode === 'register' ? registerForm.email : loginForm.email}
        password={authMode === 'register' ? registerForm.password : loginForm.password}
        confirmPassword={registerForm.confirmPassword}
        mfaCode={loginForm.mfaCode}
        mfaRequired={loginRequiresMfaCode}
        loginHints={LOGIN_HINTS}
        busy={busyKey === 'login' || busyKey === 'register'}
        error={error}
        onModeChange={(mode) => {
          setAuthMode(mode);
          setError('');
          setLoginRequiresMfaCode(false);
        }}
        onNameChange={(value) => setRegisterForm((prev) => ({ ...prev, name: value }))}
        onEmailChange={(value) => {
          if (authMode === 'register') {
            setRegisterForm((prev) => ({ ...prev, email: value }));
            return;
          }
          setLoginForm((prev) => ({ ...prev, email: value }));
        }}
        onPasswordChange={(value) => {
          if (authMode === 'register') {
            setRegisterForm((prev) => ({ ...prev, password: value }));
            return;
          }
          setLoginForm((prev) => ({ ...prev, password: value }));
        }}
        onConfirmPasswordChange={(value) => setRegisterForm((prev) => ({ ...prev, confirmPassword: value }))}
        onMfaCodeChange={(value) => setLoginForm((prev) => ({ ...prev, mfaCode: value }))}
        onSubmit={authMode === 'register' ? handleRegister : handleLogin}
      />
    );
  }

  if (user.mustChangePassword) {
    return (
      <PasswordChangeScreen
        currentPassword={changePasswordForm.currentPassword}
        newPassword={changePasswordForm.newPassword}
        confirmNewPassword={changePasswordForm.confirmNewPassword}
        busy={busyKey === 'change-password'}
        error={error}
        onCurrentPasswordChange={(value) =>
          setChangePasswordForm((prev) => ({ ...prev, currentPassword: value }))
        }
        onNewPasswordChange={(value) => setChangePasswordForm((prev) => ({ ...prev, newPassword: value }))}
        onConfirmNewPasswordChange={(value) =>
          setChangePasswordForm((prev) => ({ ...prev, confirmNewPassword: value }))
        }
        onSubmit={handleForcedPasswordChange}
        onLogout={() => {
          void handleLogout();
        }}
      />
    );
  }

  if (isMfaEnrollmentRequired(user)) {
    return (
      <MfaEnrollmentScreen
        userName={user.name}
        userEmail={user.email}
        setupPayload={mfaSetupPayload}
        verificationCode={mfaVerificationCode}
        busy={busyKey === 'mfa-setup' || busyKey === 'mfa-verify'}
        error={error}
        onGenerateSetup={generateMfaSetup}
        onVerificationCodeChange={setMfaVerificationCode}
        onVerify={verifyMfaSetup}
        onLogout={() => {
          void handleLogout();
        }}
      />
    );
  }

  if (isCompanyOnboardingRequired(user)) {
    return (
      <CompanyOnboardingScreen
        userName={user.name}
        availableCompanies={availableCompanies}
        companyCode={companyOnboardingForm.code}
        companyName={companyOnboardingForm.name}
        busy={busyKey === 'onboarding-select-company' || busyKey === 'onboarding-create-company'}
        error={error}
        onCompanyCodeChange={(value) => setCompanyOnboardingForm((prev) => ({ ...prev, code: value }))}
        onCompanyNameChange={(value) => setCompanyOnboardingForm((prev) => ({ ...prev, name: value }))}
        onCreateCompany={createCompanyDuringOnboarding}
        onSelectCompany={(companyId) => selectCompanyDuringOnboarding(companyId)}
        onLogout={() => {
          void handleLogout();
        }}
      />
    );
  }

  function renderModule() {
    if (!visibleMenuKeys.has(moduleKey)) {
      return (
        <section className="panel">
          <h3>Acces restricționat</h3>
          <p className="muted">Nu ai permisiuni pentru modulul selectat.</p>
        </section>
      );
    }

    if (moduleKey === 'dashboard') {
      return (
        <DashboardPage
          stats={stats}
          pnl={pnl}
          balanceSheet={balanceSheet}
          dashboardBi={dashboardBi}
          dashboardBiFilter={dashboardBiFilter}
          setDashboardBiFilter={setDashboardBiFilter}
          applyDashboardBiFilter={applyDashboardBiFilter}
          canViewDashboardBi={canRead.reports}
          purchasesDashboard={purchasesDashboard}
          canViewPurchasesDashboard={canRead.purchases}
          purchasesDashboardFilter={purchasesDashboardFilter}
          setPurchasesDashboardFilter={setPurchasesDashboardFilter}
          applyPurchasesDashboardFilter={applyPurchasesDashboardFilter}
          busyKey={busyKey}
          fmtCurrency={fmtCurrency}
        />
      );
    }

    if (moduleKey === 'admin') {
      return <AdminPage />;
    }

    if (moduleKey === 'accounts') {
      return (
        <AccountsPage
          accountForm={accountForm}
          setAccountForm={setAccountForm}
          createAccount={createAccount}
          canCreateAccount={canAction.createAccount}
          busyKey={busyKey}
          accounts={accounts}
        />
      );
    }

    if (moduleKey === 'journal') {
      return (
        <JournalPage
          journalForm={journalForm}
          setJournalForm={setJournalForm}
          createJournalEntry={createJournalEntry}
          canCreateJournalEntry={canAction.createJournalEntry}
          busyKey={busyKey}
          accounts={accounts}
          journalEntries={journalEntries}
        />
      );
    }

    if (moduleKey === 'partners') {
      return (
        <PartnersPage
          partnerForm={partnerForm}
          setPartnerForm={setPartnerForm}
          createPartner={createPartner}
          canCreatePartner={canAction.createPartner}
          busyKey={busyKey}
          partners={partners}
        />
      );
    }

    if (moduleKey === 'invoices') {
      return (
        <InvoicesPage
          invoiceForm={invoiceForm}
          setInvoiceForm={setInvoiceForm}
          createInvoice={createInvoice}
          canCreateInvoice={canAction.createInvoice}
          busyKey={busyKey}
          partners={partners}
          invoices={invoices}
          collectInvoice={collectInvoice}
          canCollectInvoice={canAction.collectInvoice}
          fmtCurrency={fmtCurrency}
          toNum={toNum}
        />
      );
    }

    if (moduleKey === 'purchases') {
      return (
        <PurchasesPage
          supplierInvoiceForm={supplierInvoiceForm}
          setSupplierInvoiceForm={setSupplierInvoiceForm}
          createSupplierInvoice={createSupplierInvoice}
          canCreateSupplierInvoice={canAction.createSupplierInvoice}
          busyKey={busyKey}
          suppliers={supplierPartners}
          supplierInvoices={supplierInvoices}
          approveSupplierInvoice={(invoice) => {
            void approveSupplierInvoice(invoice, 'WEB');
          }}
          approveSupplierInvoiceMobile={(invoice) => {
            void approveSupplierInvoice(invoice, 'MOBILE');
          }}
          rejectSupplierInvoice={rejectSupplierInvoice}
          canApproveSupplierInvoice={canAction.approveSupplierInvoice}
          canApproveSupplierInvoiceMobile={canAction.approveSupplierInvoiceMobile}
          canRejectSupplierInvoice={canAction.rejectSupplierInvoice}
          paySupplierInvoice={paySupplierInvoice}
          canPaySupplierInvoice={canAction.paySupplierInvoice}
          purchaseDelegationForm={purchaseDelegationForm}
          setPurchaseDelegationForm={setPurchaseDelegationForm}
          createPurchaseDelegation={createPurchaseDelegation}
          canDelegateSupplierInvoiceApproval={canAction.delegateSupplierInvoiceApproval}
          purchaseApprovers={purchaseApprovers}
          purchaseDelegations={purchaseDelegations}
          fmtCurrency={fmtCurrency}
          toNum={toNum}
        />
      );
    }

    if (moduleKey === 'stocks') {
      return (
        <StocksPage
          stockItemForm={stockItemForm}
          setStockItemForm={setStockItemForm}
          createStockItem={createStockItem}
          canCreateStockItem={canAction.createStockItem}
          nirForm={nirForm}
          setNirForm={setNirForm}
          registerNir={registerNir}
          canRegisterNir={canAction.registerNir}
          consumptionForm={consumptionForm}
          setConsumptionForm={setConsumptionForm}
          registerStockConsumption={registerStockConsumption}
          canRegisterStockConsumption={canAction.registerStockConsumption}
          inventoryForm={inventoryForm}
          setInventoryForm={setInventoryForm}
          reconcileStockInventory={reconcileStockInventory}
          canReconcileStockInventory={canAction.reconcileStockInventory}
          busyKey={busyKey}
          stockItems={stockItems}
          stockMovements={stockMovements}
          fmtCurrency={fmtCurrency}
          toNum={toNum}
        />
      );
    }

    if (moduleKey === 'payroll') {
      return (
        <PayrollPage
          employeeForm={employeeForm}
          setEmployeeForm={setEmployeeForm}
          createEmployee={createEmployee}
          canCreateEmployee={canAction.createEmployee}
          payrollForm={payrollForm}
          setPayrollForm={setPayrollForm}
          runPayroll={runPayroll}
          canRunPayroll={canAction.runPayroll}
          busyKey={busyKey}
          payrollRuns={payrollRuns}
          employees={employees}
          fmtCurrency={fmtCurrency}
          toNum={toNum}
        />
      );
    }

    if (moduleKey === 'revisal') {
      return (
        <RevisalPage
          revisalGenerateForm={revisalGenerateForm}
          setRevisalGenerateForm={setRevisalGenerateForm}
          generateRevisalExport={generateRevisalExport}
          selectedPeriod={anafPeriod}
          revisalDeliverForm={revisalDeliverForm}
          setRevisalDeliverForm={setRevisalDeliverForm}
          markRevisalDelivered={markRevisalDelivered}
          canManageRevisal={canAction.runPayroll}
          busyKey={busyKey}
          revisalExports={revisalExports}
          downloadRevisalXml={downloadRevisalXml}
        />
      );
    }

    if (moduleKey === 'assets') {
      return (
        <AssetsPage
          assetForm={assetForm}
          setAssetForm={setAssetForm}
          createAsset={createAsset}
          canCreateAsset={canAction.createAsset}
          depreciationForm={depreciationForm}
          setDepreciationForm={setDepreciationForm}
          runDepreciation={runDepreciation}
          canRunDepreciation={canAction.runDepreciation}
          busyKey={busyKey}
          assets={assets}
          fmtCurrency={fmtCurrency}
          toNum={toNum}
        />
      );
    }

    if (moduleKey === 'reports') {
      return (
        <ReportsPage
          busyKey={busyKey}
          downloadFinancialExport={downloadFinancialExport}
          financialStatements={financialStatements}
          downloadAnafExport={downloadAnafExport}
          checkAnafValidation={checkAnafValidation}
          canExportReports={canAction.exportReports}
          anafInfo={anafInfo}
          trialBalance={trialBalance}
          pnl={pnl}
          balanceSheet={balanceSheet}
          aging={aging}
          fmtCurrency={fmtCurrency}
        />
      );
    }

    return <AuditPage auditLogs={auditLogs} />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h2>SEGA</h2>
          <small>Contabilitate Integrată</small>
        </div>

        <div className="user-box">
          <strong>{user.name}</strong>
          {availableCompanies.length > 1 ? (
            <label className="company-switcher">
              Companie activă
              <select
                value={user.companyId ?? ''}
                onChange={(event) => void switchCompany(event.target.value)}
                disabled={busyKey === 'switch-company'}
              >
                {availableCompanies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name} ({company.code})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span>
              {user.companyName ?? 'Companie implicită'}
              {user.companyCode ? ` (${user.companyCode})` : ''}
            </span>
          )}
          <label className="period-switcher">
            Perioadă (an/lună)
            <div className="period-switcher-row">
              <select value={String(FIXED_PERIOD_YEAR)} disabled>
                <option value={String(FIXED_PERIOD_YEAR)}>{FIXED_PERIOD_YEAR}</option>
              </select>
              <select
                value={periodParts.month}
                onChange={(event) => handleSidebarMonthChange(event.target.value)}
              >
                {MONTH_OPTIONS.map((month) => (
                  <option key={month.value} value={month.value} disabled={Number(month.value) > maxEnabledMonth}>
                    {month.label}
                  </option>
                ))}
              </select>
            </div>
          </label>
        </div>

        <nav>
          {visibleMenuItems.map((item) => (
            <button
              key={item.key}
              className={moduleKey === item.key ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setModuleKey(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <button className="sidebar-logout" onClick={() => void handleLogout()}>
          Ieșire
        </button>
      </aside>

      <main className="content">
        <header className="topbar">
          <h1>{visibleMenuItems.find((item) => item.key === moduleKey)?.label ?? 'Dashboard'}</h1>
          <div className="topbar-actions">
            {moduleKey === 'accounts' ? (
              <button onClick={() => void openAccountsListPdf()} disabled={busyKey === 'accounts-list-pdf'}>
                {busyKey === 'accounts-list-pdf' ? 'Listare...' : 'List'}
              </button>
            ) : null}
            {moduleKey === 'journal' ? (
              <button onClick={() => void openJournalEntriesListPdf()} disabled={busyKey === 'journal-list-pdf'}>
                {busyKey === 'journal-list-pdf' ? 'Listare...' : 'List'}
              </button>
            ) : null}
            {moduleKey === 'partners' ? (
              <button onClick={() => void openPartnersListPdf()} disabled={busyKey === 'partners-list-pdf'}>
                {busyKey === 'partners-list-pdf' ? 'Listare...' : 'List'}
              </button>
            ) : null}
            {moduleKey === 'invoices' ? (
              <button onClick={() => void openInvoicesListPdf()} disabled={busyKey === 'invoices-list-pdf'}>
                {busyKey === 'invoices-list-pdf' ? 'Listare...' : 'List Facturi'}
              </button>
            ) : null}
            {moduleKey === 'purchases' ? (
              <button onClick={() => void openPurchasesListPdf()} disabled={busyKey === 'purchases-list-pdf'}>
                {busyKey === 'purchases-list-pdf' ? 'Listare...' : 'List'}
              </button>
            ) : null}
            {moduleKey === 'stocks' ? (
              <button onClick={() => void openStocksListPdf()} disabled={busyKey === 'stocks-list-pdf'}>
                {busyKey === 'stocks-list-pdf' ? 'Listare...' : 'List'}
              </button>
            ) : null}
            {moduleKey === 'payroll' ? (
              <button
                onClick={() => void openPayrollEmployeesListPdf()}
                disabled={busyKey === 'payroll-employees-list-pdf'}
              >
                {busyKey === 'payroll-employees-list-pdf' ? 'Listare...' : 'List Angajați'}
              </button>
            ) : null}
            {moduleKey === 'payroll' ? (
              <button onClick={() => void openPayrollRunsListPdf()} disabled={busyKey === 'payroll-runs-list-pdf'}>
                {busyKey === 'payroll-runs-list-pdf' ? 'Listare...' : 'List State'}
              </button>
            ) : null}
            {moduleKey === 'revisal' ? (
              <button onClick={() => void openRevisalExportsListPdf()} disabled={busyKey === 'revisal-list-pdf'}>
                {busyKey === 'revisal-list-pdf' ? 'Listare...' : 'List Revisal'}
              </button>
            ) : null}
            {moduleKey === 'assets' ? (
              <button onClick={() => void openAssetsListPdf()} disabled={busyKey === 'assets-list-pdf'}>
                {busyKey === 'assets-list-pdf' ? 'Listare...' : 'List Mijloace fixe'}
              </button>
            ) : null}
            <button onClick={() => void loadModuleData(moduleKey, { force: true })} disabled={loading}>
              {loading ? 'Actualizare...' : 'Refresh date'}
            </button>
          </div>
        </header>

        {showConnectivityBanner ? (
          <section className={`connectivity-banner ${isOnline ? 'connectivity-banner-online' : 'connectivity-banner-offline'}`}>
            <div>
              <strong>
                {!isOnline
                  ? 'Mod offline activ'
                  : offlineSyncStatus === 'syncing'
                    ? 'Sincronizare coadă în curs'
                    : offlineSyncStatus === 'error'
                      ? 'Sincronizare coadă întreruptă'
                      : 'Conectat'}
              </strong>
              <p className="muted">
                {!isOnline
                  ? 'Datele sunt disponibile în regim read-only. Operațiunile de scriere se adaugă în coada locală.'
                  : `Operațiuni în coadă: ${offlineWriteQueue.length}.`}
              </p>
              {offlineSyncMessage ? <p className="muted">{offlineSyncMessage}</p> : null}
            </div>
            <div className="connectivity-actions">
              <button
                className="ghost"
                onClick={() => void syncOfflineWriteQueue({ manual: true })}
                disabled={!isOnline || offlineWriteQueue.length === 0 || offlineSyncStatus === 'syncing'}
              >
                {offlineSyncStatus === 'syncing' ? 'Sincronizare...' : 'Sincronizează coada'}
              </button>
            </div>
          </section>
        ) : null}
        {error ? <div className="alert">{error}</div> : null}
        {renderModule()}
      </main>

      {paymentDialog ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" role="dialog" aria-modal="true" aria-label="Dialog plată">
            <header className="modal-header">
              <h3 className="flow-title">
                <span>{paymentDialog.flow === 'INVOICE_COLLECTION' ? 'Înregistrare încasare client' : 'Înregistrare plată furnizor'}</span>
                <span
                  className={
                    paymentDialog.flow === 'INVOICE_COLLECTION'
                      ? 'flow-badge flow-badge-inflow'
                      : 'flow-badge flow-badge-outflow'
                  }
                >
                  {paymentDialog.flow === 'INVOICE_COLLECTION' ? 'Încasare' : 'Plată'}
                </span>
              </h3>
              <button type="button" className="ghost" onClick={closePaymentDialog} disabled={busyKey === 'payment-dialog-submit'}>
                Închide
              </button>
            </header>
            <p className="muted">
              Factura {paymentDialog.invoiceNumber} | Partener {paymentDialog.partnerName} | Sold deschis{' '}
              {fmtCurrency(paymentDialog.openAmount)}
            </p>
            <form className="stack-form" onSubmit={(event) => void submitPaymentDialog(event)}>
              <div className="inline-fields">
                <label>
                  Sumă
                  <input
                    type="number"
                    step="0.01"
                    min={0.01}
                    max={paymentDialog.openAmount}
                    value={paymentDialog.amount}
                    onChange={(event) =>
                      setPaymentDialog((prev) => (prev ? { ...prev, amount: event.target.value } : prev))
                    }
                    required
                  />
                </label>
                <label>
                  Metodă
                  <select
                    value={paymentDialog.method}
                    onChange={(event) =>
                      setPaymentDialog((prev) =>
                        prev
                          ? {
                              ...prev,
                              method: event.target.value as PaymentDialogMethod,
                            }
                          : prev,
                      )
                    }
                  >
                    <option value="BANK_TRANSFER">Transfer bancar</option>
                    <option value="CASH">Numerar</option>
                    <option value="CARD">Card</option>
                    <option value="OTHER">Altă metodă</option>
                  </select>
                </label>
              </div>
              <div className="inline-fields">
                <label>
                  Data operațiunii
                  <input
                    type="datetime-local"
                    value={paymentDialog.date}
                    onChange={(event) => setPaymentDialog((prev) => (prev ? { ...prev, date: event.target.value } : prev))}
                    required
                  />
                </label>
                <label>
                  Referință
                  <input
                    value={paymentDialog.reference}
                    onChange={(event) =>
                      setPaymentDialog((prev) => (prev ? { ...prev, reference: event.target.value } : prev))
                    }
                    placeholder="Ex: extras bancar / OP"
                  />
                </label>
              </div>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={paymentDialog.autoPost}
                  onChange={(event) =>
                    setPaymentDialog((prev) =>
                      prev
                        ? {
                            ...prev,
                            autoPost: event.target.checked,
                          }
                        : prev,
                    )
                  }
                />
                Postare automată notă contabilă
              </label>
              {paymentDialogError ? <div className="alert">{paymentDialogError}</div> : null}
              <div className="button-row">
                <button type="submit" disabled={busyKey === 'payment-dialog-submit'}>
                  {busyKey === 'payment-dialog-submit' ? 'Procesare...' : 'Confirmă operațiunea'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={closePaymentDialog}
                  disabled={busyKey === 'payment-dialog-submit'}
                >
                  Anulează
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default App;
