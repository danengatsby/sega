import type { Permission, Role } from '../types';

export type ModuleKey =
  | 'admin'
  | 'dashboard'
  | 'accounts'
  | 'journal'
  | 'partners'
  | 'invoices'
  | 'purchases'
  | 'stocks'
  | 'payroll'
  | 'revisal'
  | 'assets'
  | 'reports'
  | 'audit';

export interface MenuItem {
  key: ModuleKey;
  label: string;
  requiredPermissions: Permission[];
}

export const MENU_ITEMS: MenuItem[] = [
  { key: 'dashboard', label: 'Dashboard', requiredPermissions: [] },
  { key: 'accounts', label: 'Plan conturi', requiredPermissions: ['accounts.read'] },
  { key: 'journal', label: 'Note contabile', requiredPermissions: ['journal.read'] },
  { key: 'partners', label: 'Parteneri', requiredPermissions: ['partners.read'] },
  { key: 'invoices', label: 'Facturi și încasări', requiredPermissions: ['invoices.read'] },
  { key: 'purchases', label: 'Facturi furnizori și plăți', requiredPermissions: ['purchases.read'] },
  { key: 'stocks', label: 'Stocuri', requiredPermissions: ['stocks.read'] },
  { key: 'payroll', label: 'Salarii', requiredPermissions: ['payroll.read'] },
  { key: 'revisal', label: 'Revisal', requiredPermissions: ['payroll.read'] },
  { key: 'assets', label: 'Mijloace fixe', requiredPermissions: ['assets.read'] },
  { key: 'reports', label: 'Rapoarte', requiredPermissions: ['reports.read'] },
  { key: 'audit', label: 'Audit Trail', requiredPermissions: ['audit.read'] },
];

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrator',
  CHIEF_ACCOUNTANT: 'Contabil Șef',
  ACCOUNTANT: 'Contabil',
  CASHIER: 'Casier',
  MANAGER: 'Manager',
  AUDITOR: 'Auditor',
};
