import { useMemo } from 'react';
import { MENU_ITEMS, type MenuItem } from '../app/navigation';
import type { Permission, User } from '../types';

export interface ReadCapabilities {
  accounts: boolean;
  partners: boolean;
  invoices: boolean;
  purchases: boolean;
  stocks: boolean;
  employees: boolean;
  payroll: boolean;
  assets: boolean;
  journal: boolean;
  reports: boolean;
  audit: boolean;
}

export interface ActionCapabilities {
  createAccount: boolean;
  createPartner: boolean;
  createInvoice: boolean;
  collectInvoice: boolean;
  createSupplierInvoice: boolean;
  approveSupplierInvoice: boolean;
  approveSupplierInvoiceMobile: boolean;
  rejectSupplierInvoice: boolean;
  delegateSupplierInvoiceApproval: boolean;
  paySupplierInvoice: boolean;
  createStockItem: boolean;
  registerNir: boolean;
  registerStockConsumption: boolean;
  reconcileStockInventory: boolean;
  createJournalEntry: boolean;
  createEmployee: boolean;
  runPayroll: boolean;
  createAsset: boolean;
  runDepreciation: boolean;
  exportReports: boolean;
}

interface PermissionState {
  grantedPermissions: Set<Permission>;
  canRead: ReadCapabilities;
  canAction: ActionCapabilities;
  visibleMenuItems: MenuItem[];
  visibleMenuKeys: Set<MenuItem['key']>;
}

function hasAnyPermission(grantedPermissions: Set<Permission>, requiredPermissions: Permission[]): boolean {
  if (requiredPermissions.length === 0) {
    return true;
  }

  return requiredPermissions.some((permission) => grantedPermissions.has(permission));
}

export function usePermissions(user: User | null): PermissionState {
  const grantedPermissions = useMemo(
    () => new Set((user?.permissions ?? []) as Permission[]),
    [user?.permissions],
  );

  const canRead = useMemo(
    () => ({
      accounts: grantedPermissions.has('accounts.read'),
      partners: grantedPermissions.has('partners.read'),
      invoices: grantedPermissions.has('invoices.read'),
      purchases: grantedPermissions.has('purchases.read'),
      stocks: grantedPermissions.has('stocks.read'),
      employees: grantedPermissions.has('employees.read'),
      payroll: grantedPermissions.has('payroll.read'),
      assets: grantedPermissions.has('assets.read'),
      journal: grantedPermissions.has('journal.read'),
      reports: grantedPermissions.has('reports.read'),
      audit: grantedPermissions.has('audit.read'),
    }),
    [grantedPermissions],
  );

  const canAction = useMemo(
    () => ({
      createAccount: grantedPermissions.has('accounts.write'),
      createPartner: grantedPermissions.has('partners.write'),
      createInvoice: grantedPermissions.has('invoices.write'),
      collectInvoice: grantedPermissions.has('payments.write'),
      createSupplierInvoice: grantedPermissions.has('purchases.write'),
      approveSupplierInvoice: grantedPermissions.has('purchases.approve'),
      approveSupplierInvoiceMobile: grantedPermissions.has('purchases.approve'),
      rejectSupplierInvoice: grantedPermissions.has('purchases.approve'),
      delegateSupplierInvoiceApproval: grantedPermissions.has('purchases.delegate'),
      paySupplierInvoice: grantedPermissions.has('purchases.payments.write'),
      createStockItem: grantedPermissions.has('stocks.write'),
      registerNir: grantedPermissions.has('stocks.write'),
      registerStockConsumption: grantedPermissions.has('stocks.write'),
      reconcileStockInventory: grantedPermissions.has('stocks.write'),
      createJournalEntry: grantedPermissions.has('journal.write'),
      createEmployee: grantedPermissions.has('employees.write'),
      runPayroll: grantedPermissions.has('payroll.generate'),
      createAsset: grantedPermissions.has('assets.write'),
      runDepreciation: grantedPermissions.has('assets.run-depreciation'),
      exportReports: grantedPermissions.has('reports.export'),
    }),
    [grantedPermissions],
  );

  const visibleMenuItems = useMemo(
    () => MENU_ITEMS.filter((item) => hasAnyPermission(grantedPermissions, item.requiredPermissions)),
    [grantedPermissions],
  );

  const visibleMenuKeys = useMemo(
    () => new Set(visibleMenuItems.map((item) => item.key)),
    [visibleMenuItems],
  );

  return {
    grantedPermissions,
    canRead,
    canAction,
    visibleMenuItems,
    visibleMenuKeys,
  };
}
