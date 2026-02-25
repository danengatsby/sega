import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Role } from '@prisma/client';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { requirePermissions } from './auth.js';
import { PERMISSIONS, permissionsForRole, type Permission } from '../lib/rbac.js';

const ALL_ROLES = Object.values(Role) as Role[];

interface EndpointScenario {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  requiredPermissions: Permission[];
  allowedRoles: Role[];
}

const ENDPOINT_SCENARIOS: EndpointScenario[] = [
  {
    name: 'POST /accounts',
    method: 'POST',
    path: '/accounts',
    requiredPermissions: [PERMISSIONS.ACCOUNTS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    name: 'POST /payroll/runs/generate',
    method: 'POST',
    path: '/payroll/runs/generate',
    requiredPermissions: [PERMISSIONS.PAYROLL_GENERATE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    name: 'GET /revisal/exports',
    method: 'GET',
    path: '/revisal/exports',
    requiredPermissions: [PERMISSIONS.PAYROLL_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER, Role.AUDITOR],
  },
  {
    name: 'POST /revisal/exports',
    method: 'POST',
    path: '/revisal/exports',
    requiredPermissions: [PERMISSIONS.PAYROLL_GENERATE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    name: 'POST /assets/run-depreciation',
    method: 'POST',
    path: '/assets/run-depreciation',
    requiredPermissions: [PERMISSIONS.ASSETS_RUN_DEPRECIATION],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    name: 'POST /invoices/:id/pay',
    method: 'POST',
    path: '/invoices/INV-1/pay',
    requiredPermissions: [PERMISSIONS.PAYMENTS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER],
  },
  {
    name: 'POST /purchases/invoices/:id/pay',
    method: 'POST',
    path: '/purchases/invoices/AP-1/pay',
    requiredPermissions: [PERMISSIONS.PURCHASE_PAYMENTS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER],
  },
  {
    name: 'POST /purchases/invoices/:id/approve',
    method: 'POST',
    path: '/purchases/invoices/AP-1/approve',
    requiredPermissions: [PERMISSIONS.PURCHASE_APPROVE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER],
  },
  {
    name: 'POST /purchases/delegations',
    method: 'POST',
    path: '/purchases/delegations',
    requiredPermissions: [PERMISSIONS.PURCHASE_DELEGATE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER],
  },
  {
    name: 'GET /stocks/items',
    method: 'GET',
    path: '/stocks/items',
    requiredPermissions: [PERMISSIONS.STOCKS_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER, Role.MANAGER, Role.AUDITOR],
  },
  {
    name: 'GET /e-transport/shipments',
    method: 'GET',
    path: '/e-transport/shipments',
    requiredPermissions: [PERMISSIONS.E_TRANSPORT_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER, Role.MANAGER, Role.AUDITOR],
  },
  {
    name: 'POST /e-transport/shipments',
    method: 'POST',
    path: '/e-transport/shipments',
    requiredPermissions: [PERMISSIONS.E_TRANSPORT_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER],
  },
  {
    name: 'POST /stocks/items',
    method: 'POST',
    path: '/stocks/items',
    requiredPermissions: [PERMISSIONS.STOCKS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
  },
  {
    name: 'GET /reports/export/financial.xml',
    method: 'GET',
    path: '/reports/export/financial.xml',
    requiredPermissions: [PERMISSIONS.REPORTS_EXPORT],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER, Role.AUDITOR],
  },
  {
    name: 'GET /reports/dashboard-bi',
    method: 'GET',
    path: '/reports/dashboard-bi',
    requiredPermissions: [PERMISSIONS.REPORTS_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER, Role.MANAGER, Role.AUDITOR],
  },
  {
    name: 'GET /reports/export/financial.xbrl',
    method: 'GET',
    path: '/reports/export/financial.xbrl',
    requiredPermissions: [PERMISSIONS.REPORTS_EXPORT],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER, Role.AUDITOR],
  },
  {
    name: 'GET /audit-log',
    method: 'GET',
    path: '/audit-log',
    requiredPermissions: [PERMISSIONS.AUDIT_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER, Role.AUDITOR],
  },
  {
    name: 'POST /periods/:period/close',
    method: 'POST',
    path: '/periods/2026-01/close',
    requiredPermissions: [PERMISSIONS.PERIODS_MANAGE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT],
  },
];

let server: Server;
let baseUrl = '';

function createRbacProbeApp(): Express {
  const app = express();

  app.use((req, _res, next) => {
    const roleHeader = req.header('x-test-role');
    if (!roleHeader) {
      next();
      return;
    }

    if (!Object.values(Role).includes(roleHeader as Role)) {
      next();
      return;
    }

    const role = roleHeader as Role;
    req.user = {
      id: 'test-user-id',
      email: 'rbac@test.local',
      role,
      companyRole: role,
      name: 'RBAC Test User',
      mustChangePassword: false,
      mfaEnabled: false,
      permissions: permissionsForRole(role),
    };
    next();
  });

  for (const scenario of ENDPOINT_SCENARIOS) {
    app[scenario.method.toLowerCase() as 'get' | 'post'](
      scenario.path,
      requirePermissions(...scenario.requiredPermissions),
      (_req, res) => {
        res.status(200).json({ ok: true, endpoint: scenario.name });
      },
    );
  }

  return app;
}

async function sendProbeRequest(method: 'GET' | 'POST', path: string, role?: Role): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: role ? { 'x-test-role': role } : undefined,
  });
}

before(async () => {
  const app = createRbacProbeApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.on('listening', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
});

test('endpoint-urile protejate returnează 401 fără utilizator autentificat', async () => {
  const response = await sendProbeRequest('POST', '/accounts');
  assert.equal(response.status, 401);
});

test('matrice RBAC pe endpoint-uri: allow/deny pe roluri', async () => {
  for (const scenario of ENDPOINT_SCENARIOS) {
    for (const role of ALL_ROLES) {
      const response = await sendProbeRequest(scenario.method, scenario.path, role);
      const shouldAllow = scenario.allowedRoles.includes(role);
      const expectedStatus = shouldAllow ? 200 : 403;

      assert.equal(
        response.status,
        expectedStatus,
        `${scenario.name} pentru rolul ${role} a returnat ${response.status}, expected ${expectedStatus}`,
      );

      if (!shouldAllow) {
        const payload = (await response.json()) as { missingPermissions?: Permission[] };
        for (const requiredPermission of scenario.requiredPermissions) {
          assert.equal(
            payload.missingPermissions?.includes(requiredPermission) ?? false,
            true,
            `${scenario.name} / ${role} nu raportează lipsa permisiunii ${requiredPermission}`,
          );
        }
      }
    }
  }
});
