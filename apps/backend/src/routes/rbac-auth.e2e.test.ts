import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import bcrypt from 'bcrypt';
import { generateSecret, generateSync } from 'otplib';
import { Role } from '@prisma/client';
import { createApp } from '../app.js';
import { env, envMeta } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS, type Permission } from '../lib/rbac.js';

const ALL_ROLES = Object.values(Role) as Role[];
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PASSWORD = 'RbacE2e!Pass2026';
const TEST_COMPANY_CODE = `e2e-${RUN_ID}`;
const TEST_COMPANY_NAME = `E2E RBAC ${RUN_ID}`;
const TEST_SECONDARY_COMPANY_CODE = `e2e-secondary-${RUN_ID}`;
const TEST_SECONDARY_COMPANY_NAME = `E2E RBAC Secondary ${RUN_ID}`;
const JOURNAL_LOOKUP_MAX_ATTEMPTS = 8;
const JOURNAL_LOOKUP_DELAY_MS = 60;

interface TestUser {
  id: string;
  role: Role;
  email: string;
  mfaSecret: string | null;
}

interface EndpointScenario {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  requiredPermissions: Permission[];
  allowedRoles: Role[];
  expectedAllowedStatus: number;
  body?: (role: Role) => unknown;
}

const RBAC_SCENARIOS: EndpointScenario[] = [
  {
    name: 'GET /api/accounts',
    method: 'GET',
    path: '/api/accounts',
    requiredPermissions: [PERMISSIONS.ACCOUNTS_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.MANAGER, Role.AUDITOR],
    expectedAllowedStatus: 200,
  },
  {
    name: 'POST /api/accounts',
    method: 'POST',
    path: '/api/accounts',
    requiredPermissions: [PERMISSIONS.ACCOUNTS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
    expectedAllowedStatus: 201,
    body: (role) => ({
      code: `E2E-${role.slice(0, 3)}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`.slice(0, 30),
      name: `Cont RBAC ${role}`,
      type: 'ASSET',
      currency: 'RON',
      reason: 'e2e-rbac',
    }),
  },
  {
    name: 'GET /api/stocks/items',
    method: 'GET',
    path: '/api/stocks/items',
    requiredPermissions: [PERMISSIONS.STOCKS_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER, Role.MANAGER, Role.AUDITOR],
    expectedAllowedStatus: 200,
  },
  {
    name: 'POST /api/stocks/items',
    method: 'POST',
    path: '/api/stocks/items',
    requiredPermissions: [PERMISSIONS.STOCKS_WRITE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT],
    expectedAllowedStatus: 201,
    body: (role) => ({
      code: `STK-${role.slice(0, 3)}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`.slice(0, 40),
      name: `Articol RBAC ${role}`,
      unit: 'BUC',
      valuationMethod: 'FIFO',
      minStockQty: 1,
      initialQuantity: 0,
      reason: 'e2e-rbac',
    }),
  },
  {
    name: 'GET /api/audit-log',
    method: 'GET',
    path: '/api/audit-log?take=5',
    requiredPermissions: [PERMISSIONS.AUDIT_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.MANAGER, Role.AUDITOR],
    expectedAllowedStatus: 200,
  },
  {
    name: 'GET /api/compliance/report',
    method: 'GET',
    path: '/api/compliance/report',
    requiredPermissions: [PERMISSIONS.AUDIT_READ],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.MANAGER, Role.AUDITOR],
    expectedAllowedStatus: 200,
  },
  {
    name: 'POST /api/compliance/retention/run',
    method: 'POST',
    path: '/api/compliance/retention/run',
    requiredPermissions: [],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT],
    expectedAllowedStatus: 200,
  },
  {
    name: 'POST /api/periods/:period/close',
    method: 'POST',
    path: '/api/periods/2026-01/close',
    requiredPermissions: [PERMISSIONS.PERIODS_MANAGE],
    allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT],
    expectedAllowedStatus: 200,
    body: () => ({
      reason: 'e2e-rbac',
      notes: 'closing period for rbac e2e',
    }),
  },
];

let server: Server | null = null;
let baseUrl = '';
let companyId: string | null = null;
let secondaryCompanyId: string | null = null;
let customerPartnerId: string | null = null;
let supplierPartnerId: string | null = null;
let customerInvoiceId: string | null = null;
let supplierInvoiceId: string | null = null;
const usersByRole = new Map<Role, TestUser>();
const cookiesByRole = new Map<Role, string>();

function extractCookieHeader(response: Response): string {
  const rawCookies = response.headers.getSetCookie();
  const cookieHeader = rawCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie && cookie.length > 0))
    .join('; ');

  return cookieHeader;
}

async function loginAndGetCookieHeader(user: TestUser): Promise<string> {
  assert.ok(companyId, 'Compania principală lipsește pentru selecția obligatorie post-login');

  const mfaCode = user.mfaSecret ? generateSync({ secret: user.mfaSecret }) : undefined;
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: user.email,
      password: TEST_PASSWORD,
      mfaCode,
    }),
  });

  assert.equal(response.status, 200, `Login eșuat pentru ${user.email} cu status ${response.status}`);
  const loginCookieHeader = extractCookieHeader(response);
  assert.ok(loginCookieHeader.includes('sega_access_token='), `Cookie de acces lipsă pentru ${user.email}`);

  const switchResponse = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      companyId,
      makeDefault: true,
      reason: 'rbac-e2e-initial-company-selection',
    }),
  });

  assert.equal(
    switchResponse.status,
    200,
    `Selectarea companiei după login a eșuat pentru ${user.email} cu status ${switchResponse.status}`,
  );
  const switchedCookieHeader = extractCookieHeader(switchResponse);
  assert.ok(switchedCookieHeader.includes('sega_access_token='), `Cookie nou lipsă după switch-company pentru ${user.email}`);
  return switchedCookieHeader;
}

async function requestAsRole(
  role: Role,
  method: 'GET' | 'POST',
  path: string,
  bodyData?: unknown,
): Promise<Response> {
  const cookieHeader = cookiesByRole.get(role);
  assert.ok(cookieHeader, `Sesiune lipsă pentru rolul ${role}`);

  const headers: Record<string, string> = {
    cookie: cookieHeader,
  };

  let body: string | undefined;
  if (typeof bodyData !== 'undefined') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(bodyData);
  }

  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body,
  });
}

interface JournalLookupOptions {
  includeLines?: boolean;
  attempts?: number;
  delayMs?: number;
}

async function findJournalEntryByDescription(
  description: string,
  options: JournalLookupOptions = {},
): Promise<
  | {
      id: string;
      lines?: Array<{ debit: unknown; credit: unknown }>;
    }
  | null
> {
  assert.ok(companyId, 'Compania fixture lipsește pentru verificarea jurnalului contabil.');
  const attempts = options.attempts ?? JOURNAL_LOOKUP_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? JOURNAL_LOOKUP_DELAY_MS;
  const includeLines = options.includeLines === true;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const entry = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.enforce_rls', '0', true)`;
      if (includeLines) {
        return tx.journalEntry.findFirst({
          where: {
            companyId: companyId!,
            description,
          },
          include: {
            lines: true,
          },
        });
      }

      return tx.journalEntry.findFirst({
        where: {
          companyId: companyId!,
          description,
        },
        select: {
          id: true,
        },
      });
    });

    if (entry) {
      return entry;
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs * (attempt + 1));
    }
  }

  return null;
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server?.on('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const company = await prisma.company.create({
    data: {
      code: TEST_COMPANY_CODE,
      name: TEST_COMPANY_NAME,
      isActive: true,
    },
  });
  companyId = company.id;

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 12);
  for (const role of ALL_ROLES) {
    const email = `e2e-rbac-${RUN_ID}-${role.toLowerCase()}@sega.test`;
    const requiresMfa = role === Role.ADMIN || role === Role.CHIEF_ACCOUNTANT;
    const mfaSecret = requiresMfa ? generateSecret() : null;
    const user = await prisma.user.create({
      data: {
        email,
        name: `RBAC E2E ${role}`,
        passwordHash,
        mustChangePassword: false,
        mfaEnabled: requiresMfa,
        mfaSecret,
        role,
      },
    });

    await prisma.userCompanyMembership.create({
      data: {
        userId: user.id,
        companyId: company.id,
        role,
        isDefault: true,
      },
    });

    usersByRole.set(role, { id: user.id, role, email, mfaSecret });
  }

  const secondaryCompany = await prisma.company.create({
    data: {
      code: TEST_SECONDARY_COMPANY_CODE,
      name: TEST_SECONDARY_COMPANY_NAME,
      isActive: true,
    },
  });
  secondaryCompanyId = secondaryCompany.id;

  const adminUser = usersByRole.get(Role.ADMIN);
  assert.ok(adminUser, 'User ADMIN lipsă pentru fixture multi-company');
  await prisma.userCompanyMembership.create({
    data: {
      userId: adminUser.id,
      companyId: secondaryCompany.id,
      role: Role.MANAGER,
      isDefault: false,
    },
  });

  const customer = await prisma.partner.create({
    data: {
      companyId: company.id,
      name: `E2E Customer ${RUN_ID}`,
      type: 'CUSTOMER',
    },
  });
  customerPartnerId = customer.id;

  const supplier = await prisma.partner.create({
    data: {
      companyId: company.id,
      name: `E2E Supplier ${RUN_ID}`,
      type: 'SUPPLIER',
    },
  });
  supplierPartnerId = supplier.id;

  const now = new Date();
  const dueDate = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);
  const customerInvoice = await prisma.invoice.create({
    data: {
      companyId: company.id,
      number: `E2E-AR-${RUN_ID}`,
      kind: 'FISCAL',
      partnerId: customer.id,
      issueDate: now,
      dueDate,
      currency: 'RON',
      subtotal: 100,
      vat: 19,
      total: 119,
      status: 'ISSUED',
      description: 'Fixture invoice for RBAC E2E',
    },
  });
  customerInvoiceId = customerInvoice.id;

  const supplierInvoice = await prisma.supplierInvoice.create({
    data: {
      companyId: company.id,
      number: `E2E-AP-${RUN_ID}`,
      supplierId: supplier.id,
      receivedDate: now,
      dueDate,
      currency: 'RON',
      subtotal: 100,
      vat: 19,
      total: 119,
      status: 'RECEIVED',
      approvalStatus: 'APPROVED',
      approvalCurrentLevel: 3,
      approvalRequiredLevel: 3,
      approvalRequestedAt: now,
      approvalFinalizedAt: now,
      description: 'Fixture supplier invoice for RBAC E2E',
    },
  });
  supplierInvoiceId = supplierInvoice.id;

  for (const role of ALL_ROLES) {
    const user = usersByRole.get(role);
    assert.ok(user, `User lipsă pentru rolul ${role}`);
    const cookieHeader = await loginAndGetCookieHeader(user);
    cookiesByRole.set(role, cookieHeader);
  }
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  const userIds = Array.from(usersByRole.values()).map((user) => user.id);

  if (userIds.length > 0) {
    await prisma.refreshSession.deleteMany({
      where: {
        userId: {
          in: userIds,
        },
      },
    });

    await prisma.userCompanyMembership.deleteMany({
      where: {
        userId: {
          in: userIds,
        },
      },
    });
  }

  if (companyId) {
    await prisma.supplierPayment.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.payment.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.supplierInvoice.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.invoice.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.partner.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.stockItem.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.journalLine.deleteMany({
      where: {
        entry: {
          companyId,
        },
      },
    });

    await prisma.journalEntry.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.accountingPeriod.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.account.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.auditLog.deleteMany({
      where: {
        companyId,
      },
    });
  }

  if (secondaryCompanyId) {
    await prisma.accountingPeriod.deleteMany({
      where: {
        companyId: secondaryCompanyId,
      },
    });

    await prisma.account.deleteMany({
      where: {
        companyId: secondaryCompanyId,
      },
    });

    await prisma.stockItem.deleteMany({
      where: {
        companyId: secondaryCompanyId,
      },
    });

    await prisma.journalLine.deleteMany({
      where: {
        entry: {
          companyId: secondaryCompanyId,
        },
      },
    });

    await prisma.journalEntry.deleteMany({
      where: {
        companyId: secondaryCompanyId,
      },
    });

    await prisma.auditLog.deleteMany({
      where: {
        companyId: secondaryCompanyId,
      },
    });
  }

  if (userIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: {
        userId: {
          in: userIds,
        },
      },
    });

    await prisma.user.deleteMany({
      where: {
        id: {
          in: userIds,
        },
      },
    });
  }

  if (companyId) {
    await prisma.company.delete({
      where: {
        id: companyId,
      },
    });
  }

  if (secondaryCompanyId) {
    await prisma.company.delete({
      where: {
        id: secondaryCompanyId,
      },
    });
  }

  await prisma.$disconnect();
});

test('cookie auth real: /api/auth/me returnează contextul companiei după login', async () => {
  for (const role of ALL_ROLES) {
    const cookieHeader = cookiesByRole.get(role);
    assert.ok(cookieHeader, `Cookie lipsă pentru rolul ${role}`);

    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: {
        cookie: cookieHeader,
      },
    });

    assert.equal(response.status, 200, `/api/auth/me status invalid pentru rolul ${role}`);
    const payload = (await response.json()) as {
      user: {
        companyRole?: Role;
        permissions?: Permission[];
      };
    };

    assert.equal(payload.user.companyRole, role, `Role mismatch în contextul companiei pentru ${role}`);
    assert.ok(Array.isArray(payload.user.permissions), `Permisiuni lipsă în payload /api/auth/me pentru ${role}`);
  }
});

test('POST /api/auth/switch-company schimbă contextul și setează compania implicită', async () => {
  assert.ok(secondaryCompanyId, 'Companie secundară lipsă pentru test');
  const adminUser = usersByRole.get(Role.ADMIN);
  assert.ok(adminUser, 'User ADMIN lipsă');

  const adminCookie = cookiesByRole.get(Role.ADMIN);
  assert.ok(adminCookie, 'Cookie lipsă pentru rolul ADMIN');

  const switchResponse = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      companyId: secondaryCompanyId,
      makeDefault: true,
      reason: 'e2e-switch-company',
    }),
  });

  assert.equal(switchResponse.status, 200, 'Switch company trebuie să returneze 200');
  const switchPayload = (await switchResponse.json()) as {
    user: {
      companyId: string;
      companyRole: Role;
      availableCompanies: Array<{
        id: string;
        isDefault: boolean;
      }>;
    };
  };

  assert.equal(
    switchPayload.user.companyId,
    secondaryCompanyId,
    'Contextul de companie trebuie să fie schimbat la compania secundară',
  );
  assert.equal(
    switchPayload.user.companyRole,
    Role.MANAGER,
    'Rolul din compania secundară trebuie să fie cel din membership',
  );
  assert.equal(
    switchPayload.user.availableCompanies.some((company) => company.id === secondaryCompanyId && company.isDefault),
    true,
    'Compania secundară trebuie marcată default după switch',
  );

  const meAfterSwitch = await fetch(`${baseUrl}/api/auth/me`, {
    headers: {
      cookie: adminCookie,
    },
  });
  assert.equal(meAfterSwitch.status, 200, '/api/auth/me trebuie să răspundă după switch');
  const mePayload = (await meAfterSwitch.json()) as {
    user: {
      companyId: string;
      companyRole: Role;
    };
  };

  assert.equal(mePayload.user.companyId, secondaryCompanyId, 'Compania implicită trebuie să fie persistată după switch');
  assert.equal(mePayload.user.companyRole, Role.MANAGER, 'Rolul implicit trebuie să reflecte noua companie');

  const switchAudit = await prisma.auditLog.findFirst({
    where: {
      userId: adminUser.id,
      tableName: 'user_company_memberships',
      action: 'SWITCH_COMPANY_CONTEXT',
      companyId: secondaryCompanyId,
    },
    orderBy: [{ timestamp: 'desc' }],
  });
  assert.ok(switchAudit, 'Switch company trebuie să scrie audit log');

  assert.ok(companyId, 'Companie principală lipsă pentru reset');
  const resetResponse = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      companyId,
      makeDefault: true,
      reason: 'e2e-switch-reset-default',
    }),
  });
  assert.equal(resetResponse.status, 200, 'Reset companie implicită trebuie să reușească');
});

test('POST /api/auth/switch-company respinge schimbarea către companie fără membership', async () => {
  assert.ok(secondaryCompanyId, 'Companie secundară lipsă pentru test');
  const cashierCookie = cookiesByRole.get(Role.CASHIER);
  assert.ok(cashierCookie, 'Cookie lipsă pentru rolul CASHIER');

  const response = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: 'POST',
    headers: {
      cookie: cashierCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      companyId: secondaryCompanyId,
      makeDefault: true,
      reason: 'e2e-switch-forbidden',
    }),
  });

  assert.equal(response.status, 403, 'Schimbarea către companie neasociată trebuie respinsă');
});

test('rutele reale respectă RBAC pe roluri (allow/deny)', async () => {
  for (const scenario of RBAC_SCENARIOS) {
    for (const role of ALL_ROLES) {
      const response = await requestAsRole(
        role,
        scenario.method,
        scenario.path,
        scenario.body ? scenario.body(role) : undefined,
      );
      const shouldAllow = scenario.allowedRoles.includes(role);

      if (shouldAllow) {
        assert.equal(
          response.status,
          scenario.expectedAllowedStatus,
          `${scenario.name} ar trebui permis pentru ${role}, status primit ${response.status}`,
        );
        continue;
      }

      assert.equal(response.status, 403, `${scenario.name} ar trebui interzis pentru ${role}, status ${response.status}`);
      const payload = (await response.json()) as { missingPermissions?: Permission[] };
      for (const permission of scenario.requiredPermissions) {
        assert.equal(
          payload.missingPermissions?.includes(permission) ?? false,
          true,
          `${scenario.name}/${role} nu raportează missing permission ${permission}`,
        );
      }
    }
  }
});

test('rutele reale de încasare/plată respectă RBAC pe roluri (allow/deny)', async () => {
  assert.ok(customerInvoiceId, 'Fixture invoice client lipsă');
  assert.ok(supplierInvoiceId, 'Fixture invoice furnizor lipsă');

  const paymentDateIso = new Date().toISOString();
  const paymentScenarios: EndpointScenario[] = [
    {
      name: 'POST /api/invoices/:id/pay',
      method: 'POST',
      path: `/api/invoices/${customerInvoiceId}/pay`,
      requiredPermissions: [PERMISSIONS.PAYMENTS_WRITE],
      allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER],
      expectedAllowedStatus: 201,
      body: (role) => ({
        amount: 10,
        method: 'BANK_TRANSFER',
        autoPost: false,
        reference: `E2E-AR-PAY-${role}-${RUN_ID}`.slice(0, 64),
        date: paymentDateIso,
      }),
    },
    {
      name: 'POST /api/purchases/invoices/:id/pay',
      method: 'POST',
      path: `/api/purchases/invoices/${supplierInvoiceId}/pay`,
      requiredPermissions: [PERMISSIONS.PURCHASE_PAYMENTS_WRITE],
      allowedRoles: [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.ACCOUNTANT, Role.CASHIER],
      expectedAllowedStatus: 201,
      body: (role) => ({
        amount: 10,
        method: 'BANK_TRANSFER',
        autoPost: false,
        reference: `E2E-AP-PAY-${role}-${RUN_ID}`.slice(0, 64),
        date: paymentDateIso,
      }),
    },
  ];

  for (const scenario of paymentScenarios) {
    for (const role of ALL_ROLES) {
      const response = await requestAsRole(
        role,
        scenario.method,
        scenario.path,
        scenario.body ? scenario.body(role) : undefined,
      );
      const shouldAllow = scenario.allowedRoles.includes(role);

      if (shouldAllow) {
        assert.equal(
          response.status,
          scenario.expectedAllowedStatus,
          `${scenario.name} ar trebui permis pentru ${role}, status primit ${response.status}`,
        );
        continue;
      }

      assert.equal(response.status, 403, `${scenario.name} ar trebui interzis pentru ${role}, status ${response.status}`);
      const payload = (await response.json()) as { missingPermissions?: Permission[] };
      for (const permission of scenario.requiredPermissions) {
        assert.equal(
          payload.missingPermissions?.includes(permission) ?? false,
          true,
          `${scenario.name}/${role} nu raportează missing permission ${permission}`,
        );
      }
    }
  }

  const [customerPaymentCount, supplierPaymentCount] = await Promise.all([
    prisma.payment.count({
      where: {
        companyId,
        invoiceId: customerInvoiceId,
      },
    }),
    prisma.supplierPayment.count({
      where: {
        companyId,
        supplierInvoiceId,
      },
    }),
  ]);

  assert.equal(customerPaymentCount, 4, 'Număr invalid de încasări create pentru factura client');
  assert.equal(supplierPaymentCount, 4, 'Număr invalid de plăți create pentru factura furnizor');
});

test('validări funcționale: dueDate trebuie să fie >= issueDate/receivedDate', async () => {
  assert.ok(customerPartnerId, 'Fixture partner client lipsă');
  assert.ok(supplierPartnerId, 'Fixture partner furnizor lipsă');

  const adminCookie = cookiesByRole.get(Role.ADMIN);
  assert.ok(adminCookie, 'Cookie lipsă pentru rolul ADMIN');

  const issueDate = '2026-02-10T10:00:00.000Z';
  const receivedDate = '2026-02-10T10:00:00.000Z';
  const dueDateBefore = '2026-02-09T10:00:00.000Z';

  const customerInvoiceResponse = await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      number: `E2E-AR-DATE-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 32),
      kind: 'FISCAL',
      partnerId: customerPartnerId,
      issueDate,
      dueDate: dueDateBefore,
      subtotal: 100,
      vat: 19,
      currency: 'RON',
      autoPost: false,
    }),
  });

  assert.equal(customerInvoiceResponse.status, 400, 'Factura client cu dueDate < issueDate trebuie respinsă');
  const customerPayload = (await customerInvoiceResponse.json()) as { message?: string };
  assert.equal(
    customerPayload.message,
    'Data scadenței trebuie să fie mai mare sau egală cu data emiterii.',
    'Mesaj invalid pentru validarea dueDate >= issueDate',
  );

  const supplierInvoiceResponse = await fetch(`${baseUrl}/api/purchases/invoices`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      number: `E2E-AP-DATE-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 32),
      supplierId: supplierPartnerId,
      receivedDate,
      dueDate: dueDateBefore,
      subtotal: 100,
      vat: 19,
      currency: 'RON',
      autoPost: false,
    }),
  });

  assert.equal(supplierInvoiceResponse.status, 400, 'Factura furnizor cu dueDate < receivedDate trebuie respinsă');
  const supplierPayload = (await supplierInvoiceResponse.json()) as { message?: string };
  assert.equal(
    supplierPayload.message,
    'Data scadenței trebuie să fie mai mare sau egală cu data recepției.',
    'Mesaj invalid pentru validarea dueDate >= receivedDate',
  );
});

test('validări funcționale: PROFORMA nu postează contabil, STORNO doar pe factură fiscală sursă', async () => {
  assert.ok(companyId, 'Fixture companie lipsă');
  assert.ok(customerPartnerId, 'Fixture partner client lipsă');

  const adminCookie = cookiesByRole.get(Role.ADMIN);
  assert.ok(adminCookie, 'Cookie lipsă pentru rolul ADMIN');

  await Promise.all([
    prisma.account.upsert({
      where: {
        companyId_code: {
          companyId,
          code: '4111',
        },
      },
      update: {
        isActive: true,
      },
      create: {
        companyId,
        code: '4111',
        name: 'Clienți',
        type: 'ASSET',
        currency: 'RON',
        isActive: true,
      },
    }),
    prisma.account.upsert({
      where: {
        companyId_code: {
          companyId,
          code: '707',
        },
      },
      update: {
        isActive: true,
      },
      create: {
        companyId,
        code: '707',
        name: 'Venituri din vânzarea mărfurilor',
        type: 'REVENUE',
        currency: 'RON',
        isActive: true,
      },
    }),
    prisma.account.upsert({
      where: {
        companyId_code: {
          companyId,
          code: '4427',
        },
      },
      update: {
        isActive: true,
      },
      create: {
        companyId,
        code: '4427',
        name: 'TVA colectată',
        type: 'LIABILITY',
        currency: 'RON',
        isActive: true,
      },
    }),
  ]);

  const issueDate = '2026-02-12T10:00:00.000Z';
  const dueDate = '2026-02-20T10:00:00.000Z';

  const proformaNumber = `E2E-PROFORMA-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
  const proformaResponse = await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      number: proformaNumber,
      kind: 'PROFORMA',
      partnerId: customerPartnerId,
      issueDate,
      dueDate,
      subtotal: 200,
      vat: 38,
      currency: 'RON',
      autoPost: true,
    }),
  });

  assert.equal(proformaResponse.status, 201, 'Factura PROFORMA trebuie creată');
  const proformaPayload = (await proformaResponse.json()) as {
    id: string;
    number: string;
    kind: string;
    status: string;
  };
  assert.equal(proformaPayload.kind, 'PROFORMA');
  assert.equal(proformaPayload.status, 'DRAFT');

  const proformaPosting = await findJournalEntryByDescription(`Postare automată factură ${proformaPayload.number}`, {
    attempts: 1,
  });
  assert.equal(proformaPosting, null, 'PROFORMA nu trebuie să genereze postare contabilă');

  const proformaPayResponse = await fetch(`${baseUrl}/api/invoices/${proformaPayload.id}/pay`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amount: 50,
      method: 'BANK_TRANSFER',
      autoPost: false,
      date: issueDate,
    }),
  });
  assert.equal(proformaPayResponse.status, 400, 'Încasarea pe PROFORMA trebuie respinsă');
  const proformaPayPayload = (await proformaPayResponse.json()) as { message?: string };
  assert.equal(
    proformaPayPayload.message?.includes('doar pentru facturile de tip FISCAL'),
    true,
    'Mesaj invalid pentru restricția de încasare pe PROFORMA',
  );

  const stornoWithoutSourceResponse = await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      number: `E2E-STORNO-WO-SOURCE-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 40),
      kind: 'STORNO',
      autoPost: false,
    }),
  });
  assert.equal(stornoWithoutSourceResponse.status, 400, 'Factura STORNO fără sursă trebuie respinsă');

  const sourceNumber = `E2E-FISCAL-SOURCE-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
  const sourceResponse = await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      number: sourceNumber,
      kind: 'FISCAL',
      partnerId: customerPartnerId,
      issueDate,
      dueDate,
      subtotal: 200,
      vat: 38,
      currency: 'RON',
      autoPost: true,
    }),
  });
  assert.equal(sourceResponse.status, 201, 'Factura sursă FISCAL trebuie creată');
  const sourcePayload = (await sourceResponse.json()) as {
    id: string;
    number: string;
    partnerId: string;
  };

  const sourcePosting = await findJournalEntryByDescription(`Postare automată factură ${sourcePayload.number}`);
  assert.ok(sourcePosting?.id, 'Factura FISCAL sursă trebuie să genereze postare contabilă');

  const stornoNumber = `E2E-STORNO-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
  const stornoResponse = await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      number: stornoNumber,
      kind: 'STORNO',
      stornoOfInvoiceId: sourcePayload.id,
      issueDate: '2026-02-13T10:00:00.000Z',
      autoPost: true,
    }),
  });

  assert.equal(stornoResponse.status, 201, 'Factura STORNO validă trebuie creată');
  const stornoPayload = (await stornoResponse.json()) as {
    id: string;
    kind: string;
    partnerId: string;
    stornoOfInvoiceId: string | null;
    subtotal: string;
    vat: string;
    total: string;
  };
  assert.equal(stornoPayload.kind, 'STORNO');
  assert.equal(stornoPayload.stornoOfInvoiceId, sourcePayload.id);
  assert.equal(stornoPayload.partnerId, sourcePayload.partnerId);
  assert.equal(Number(stornoPayload.subtotal) < 0, true);
  assert.equal(Number(stornoPayload.vat) < 0, true);
  assert.equal(Number(stornoPayload.total) < 0, true);

  const stornoPosting = await findJournalEntryByDescription(`Postare automată storno ${stornoNumber}`, {
    includeLines: true,
  });
  assert.ok(stornoPosting?.id, 'Factura STORNO trebuie să genereze postare contabilă inversă');
  const debitTotal = Number(
    (stornoPosting?.lines ?? []).reduce((acc, line) => acc + Number(line.debit), 0).toFixed(2),
  );
  const creditTotal = Number(
    (stornoPosting?.lines ?? []).reduce((acc, line) => acc + Number(line.credit), 0).toFixed(2),
  );
  assert.equal(debitTotal, 238);
  assert.equal(creditTotal, 238);

  const stornoFromProformaResponse = await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      number: `E2E-STORNO-PROFORMA-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 40),
      kind: 'STORNO',
      stornoOfInvoiceId: proformaPayload.id,
      autoPost: false,
    }),
  });
  assert.equal(stornoFromProformaResponse.status, 400, 'STORNO peste PROFORMA trebuie respins');
  const stornoFromProformaPayload = (await stornoFromProformaResponse.json()) as { message?: string };
  assert.equal(
    stornoFromProformaPayload.message,
    'Se poate face STORNO doar pentru facturi de tip FISCAL.',
    'Mesaj invalid pentru STORNO peste tip document nepermis',
  );
});

test('validări funcționale: încasarea/plata sunt blocate pe statusuri nepermise', async () => {
  assert.ok(companyId, 'Fixture companie lipsă');
  assert.ok(customerPartnerId, 'Fixture partner client lipsă');
  assert.ok(supplierPartnerId, 'Fixture partner furnizor lipsă');

  const adminCookie = cookiesByRole.get(Role.ADMIN);
  assert.ok(adminCookie, 'Cookie lipsă pentru rolul ADMIN');

  const now = new Date('2026-02-11T10:00:00.000Z');
  const dueDate = new Date('2026-02-20T10:00:00.000Z');
  const [cancelledCustomerInvoice, cancelledSupplierInvoice] = await Promise.all([
    prisma.invoice.create({
      data: {
        companyId,
        number: `E2E-AR-CANCELLED-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 40),
        kind: 'FISCAL',
        partnerId: customerPartnerId,
        issueDate: now,
        dueDate,
        currency: 'RON',
        subtotal: 100,
        vat: 19,
        total: 119,
        status: 'CANCELLED',
      },
    }),
    prisma.supplierInvoice.create({
      data: {
        companyId,
        number: `E2E-AP-CANCELLED-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 40),
        supplierId: supplierPartnerId,
        receivedDate: now,
        dueDate,
        currency: 'RON',
        subtotal: 100,
        vat: 19,
        total: 119,
        status: 'CANCELLED',
      },
    }),
  ]);

  const paymentDateIso = now.toISOString();
  const [customerPaymentResponse, supplierPaymentResponse] = await Promise.all([
    fetch(`${baseUrl}/api/invoices/${cancelledCustomerInvoice.id}/pay`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount: 10,
        method: 'BANK_TRANSFER',
        autoPost: false,
        date: paymentDateIso,
      }),
    }),
    fetch(`${baseUrl}/api/purchases/invoices/${cancelledSupplierInvoice.id}/pay`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount: 10,
        method: 'BANK_TRANSFER',
        autoPost: false,
        date: paymentDateIso,
      }),
    }),
  ]);

  assert.equal(customerPaymentResponse.status, 400, 'Încasarea pe factură client anulată trebuie respinsă');
  assert.equal(supplierPaymentResponse.status, 400, 'Plata pe factură furnizor anulată trebuie respinsă');

  const customerPaymentPayload = (await customerPaymentResponse.json()) as { message?: string };
  const supplierPaymentPayload = (await supplierPaymentResponse.json()) as { message?: string };
  assert.equal(
    customerPaymentPayload.message?.includes('Statusuri permise'),
    true,
    'Mesaj invalid pentru status nepermis pe factura client',
  );
  assert.equal(
    supplierPaymentPayload.message?.includes('Statusuri permise'),
    true,
    'Mesaj invalid pentru status nepermis pe factura furnizor',
  );
});

test('strict mode ANAF forțează validarea XSD și expune header-ele de validare chiar cu validate=false', async () => {
  const adminCookie = cookiesByRole.get(Role.ADMIN);
  assert.ok(adminCookie, 'Cookie lipsă pentru rolul ADMIN');

  const originalEnv = {
    companyName: env.ANAF_COMPANY_NAME,
    companyCui: env.ANAF_COMPANY_CUI,
    companyAddress: env.ANAF_COMPANY_ADDRESS,
    companyCaen: env.ANAF_COMPANY_CAEN,
    validateXsd: env.ANAF_VALIDATE_XSD,
    xsdDir: env.ANAF_XSD_DIR,
  };
  const originalMeta = {
    companyNameProvided: envMeta.anafProfile.companyNameProvided,
    companyCuiProvided: envMeta.anafProfile.companyCuiProvided,
    companyAddressProvided: envMeta.anafProfile.companyAddressProvided,
    companyCaenProvided: envMeta.anafProfile.companyCaenProvided,
  };

  const mutableMeta = envMeta as unknown as {
    anafProfile: {
      companyNameProvided: boolean;
      companyCuiProvided: boolean;
      companyAddressProvided: boolean;
      companyCaenProvided: boolean;
    };
  };

  env.ANAF_COMPANY_NAME = 'Acme Test SRL';
  env.ANAF_COMPANY_CUI = 'RO12345679';
  env.ANAF_COMPANY_ADDRESS = 'Str. Test 1, Bucuresti';
  env.ANAF_COMPANY_CAEN = '6202';
  env.ANAF_VALIDATE_XSD = false;
  env.ANAF_XSD_DIR = `./anaf/xsd-missing-${RUN_ID}`;
  mutableMeta.anafProfile.companyNameProvided = true;
  mutableMeta.anafProfile.companyCuiProvided = true;
  mutableMeta.anafProfile.companyAddressProvided = true;
  mutableMeta.anafProfile.companyCaenProvided = true;

  try {
    const response = await fetch(
      `${baseUrl}/api/reports/export/anaf/d300.xml?period=2026-01&strict=true&validate=false`,
      {
        headers: {
          cookie: adminCookie,
        },
      },
    );

    assert.equal(response.status, 422, 'Strict mode trebuie să blocheze exportul dacă validarea XSD nu se poate executa');
    assert.equal(response.headers.get('x-anaf-declaration'), 'D300');
    assert.equal(response.headers.get('x-anaf-period'), '2026-01');
    assert.equal(response.headers.get('x-anaf-xsd-performed'), 'false');
    assert.equal(response.headers.get('x-anaf-xsd-valid'), 'unknown');

    const payload = (await response.json()) as {
      strict?: boolean;
      validation?: {
        xsd?: {
          warnings?: string[];
        };
      };
    };

    assert.equal(payload.strict, true);
    const warnings = payload.validation?.xsd?.warnings ?? [];
    assert.equal(
      warnings.some((warning) => warning.includes('Schema XSD nu există')),
      true,
      'Mesajul de warning trebuie să indice lipsa schemei XSD.',
    );
    assert.equal(
      warnings.some((warning) => warning.includes('Validarea XSD este dezactivată')),
      false,
      'În strict mode, validate=false nu trebuie să ducă la skip-ul validării XSD.',
    );
  } finally {
    env.ANAF_COMPANY_NAME = originalEnv.companyName;
    env.ANAF_COMPANY_CUI = originalEnv.companyCui;
    env.ANAF_COMPANY_ADDRESS = originalEnv.companyAddress;
    env.ANAF_COMPANY_CAEN = originalEnv.companyCaen;
    env.ANAF_VALIDATE_XSD = originalEnv.validateXsd;
    env.ANAF_XSD_DIR = originalEnv.xsdDir;
    mutableMeta.anafProfile.companyNameProvided = originalMeta.companyNameProvided;
    mutableMeta.anafProfile.companyCuiProvided = originalMeta.companyCuiProvided;
    mutableMeta.anafProfile.companyAddressProvided = originalMeta.companyAddressProvided;
    mutableMeta.anafProfile.companyCaenProvided = originalMeta.companyCaenProvided;
  }
});

test('rutele reale returnează 401 fără cookie de sesiune', async () => {
  const response = await fetch(`${baseUrl}/api/accounts`);
  assert.equal(response.status, 401);
});
