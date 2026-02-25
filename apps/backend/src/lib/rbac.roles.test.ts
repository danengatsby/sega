import assert from 'node:assert/strict';
import test from 'node:test';
import { Role } from '@prisma/client';
import { PERMISSIONS, permissionsForRole, type Permission } from './rbac.js';

const ALL_ROLES = Object.values(Role) as Role[];

interface OperationScenario {
  operation: string;
  requiredPermissions: Permission[];
  allowedRoles: Role[];
}

const OPERATION_MATRIX: OperationScenario[] = [
  {
    operation: 'administrează planul de conturi',
    requiredPermissions: [PERMISSIONS.ACCOUNTS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    operation: 'postează note contabile',
    requiredPermissions: [PERMISSIONS.JOURNAL_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    operation: 'înregistrează încasări clienți',
    requiredPermissions: [PERMISSIONS.PAYMENTS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER],
  },
  {
    operation: 'sincronizează conexiuni Open Banking',
    requiredPermissions: [PERMISSIONS.OPEN_BANKING_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    operation: 'generează și monitorizează transporturi UIT',
    requiredPermissions: [PERMISSIONS.E_TRANSPORT_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER],
  },
  {
    operation: 'înregistrează plăți furnizori',
    requiredPermissions: [PERMISSIONS.PURCHASE_PAYMENTS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER],
  },
  {
    operation: 'aprobă facturi furnizori pe fluxul AP',
    requiredPermissions: [PERMISSIONS.PURCHASE_APPROVE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER],
  },
  {
    operation: 'deleagă aprobări AP',
    requiredPermissions: [PERMISSIONS.PURCHASE_DELEGATE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER],
  },
  {
    operation: 'înregistrează NIR și consumuri de stoc',
    requiredPermissions: [PERMISSIONS.STOCKS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    operation: 'generează state de salarii',
    requiredPermissions: [PERMISSIONS.PAYROLL_GENERATE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    operation: 'generează și livrează export Revisal',
    requiredPermissions: [PERMISSIONS.PAYROLL_GENERATE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    operation: 'rulează amortizarea',
    requiredPermissions: [PERMISSIONS.ASSETS_RUN_DEPRECIATION],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    operation: 'exportă rapoarte financiare',
    requiredPermissions: [PERMISSIONS.REPORTS_EXPORT],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER, Role.AUDITOR],
  },
  {
    operation: 'închide și redeschide perioade',
    requiredPermissions: [PERMISSIONS.PERIODS_MANAGE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT],
  },
  {
    operation: 'citește audit trail',
    requiredPermissions: [PERMISSIONS.AUDIT_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER, Role.AUDITOR],
  },
];

function roleCanPerformOperation(role: Role, requiredPermissions: Permission[]): boolean {
  const grantedPermissions = new Set(permissionsForRole(role));
  return requiredPermissions.every((permission) => grantedPermissions.has(permission));
}

test('ADMIN are toate permisiunile cunoscute', () => {
  const allKnownPermissions = new Set(Object.values(PERMISSIONS));
  const adminPermissions = new Set(permissionsForRole(Role.ADMIN));

  assert.equal(adminPermissions.size, allKnownPermissions.size);
  for (const permission of allKnownPermissions) {
    assert.equal(adminPermissions.has(permission), true, `ADMIN nu are permisiunea ${permission}`);
  }
});

test('fiecare rol are cel puțin o permisiune și este subset al ADMIN', () => {
  const adminPermissions = new Set(permissionsForRole(Role.ADMIN));

  for (const role of ALL_ROLES) {
    const rolePermissions = permissionsForRole(role);
    assert.ok(rolePermissions.length > 0, `Rolul ${role} nu are permisiuni configurate`);

    for (const permission of rolePermissions) {
      assert.equal(
        adminPermissions.has(permission),
        true,
        `Permisiunea ${permission} din rolul ${role} nu există în setul ADMIN`,
      );
    }
  }
});

test('matricea RBAC pe roluri validează operațiunile principale', () => {
  for (const scenario of OPERATION_MATRIX) {
    for (const role of ALL_ROLES) {
      const expected = scenario.allowedRoles.includes(role);
      const actual = roleCanPerformOperation(role, scenario.requiredPermissions);
      assert.equal(
        actual,
        expected,
        `Rolul ${role} pentru operațiunea "${scenario.operation}" este ${actual ? 'ALLOW' : 'DENY'} în loc de ${expected ? 'ALLOW' : 'DENY'}`,
      );
    }
  }
});
