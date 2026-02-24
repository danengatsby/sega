import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { AccountType, Role } from '@prisma/client';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'OpenBanking!Integration2026';
const EMAIL = `open-banking-${RUN_ID}@sega.test`;

let server: Server | null = null;
let baseUrl = '';
let companyId: string | null = null;
let userId: string | null = null;

function extractCookieHeader(response: Response): string {
  const rawCookies = response.headers.getSetCookie();
  return rawCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie && cookie.length > 0))
    .join('; ');
}

async function loginWithCompanyContext(): Promise<string> {
  assert.ok(companyId, 'Compania fixture lipsește pentru testul Open Banking.');
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
    }),
  });

  assert.equal(loginResponse.status, 200, 'Login eșuat pentru fixture accountant');
  const loginCookieHeader = extractCookieHeader(loginResponse);

  const switchResponse = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      companyId,
      makeDefault: true,
      reason: 'open-banking-integration-switch-company',
    }),
  });

  assert.equal(switchResponse.status, 200, 'Switch company eșuat pentru fixture accountant');
  return extractCookieHeader(switchResponse);
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
      code: `ob-${RUN_ID}`.slice(0, 32),
      name: `Open Banking Test ${RUN_ID}`,
      isActive: true,
    },
  });
  companyId = company.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      name: `Open Banking User ${RUN_ID}`,
      passwordHash,
      role: Role.ACCOUNTANT,
      mustChangePassword: false,
    },
  });
  userId = user.id;

  await prisma.userCompanyMembership.create({
    data: {
      userId: user.id,
      companyId: company.id,
      role: Role.ACCOUNTANT,
      isDefault: true,
    },
  });

  await prisma.account.create({
    data: {
      companyId: company.id,
      code: '5121',
      name: 'Conturi la bănci în lei',
      type: AccountType.ASSET,
      isActive: true,
    },
  });
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

  if (userId) {
    await prisma.refreshSession.deleteMany({
      where: {
        userId,
      },
    });
  }

  if (companyId) {
    await prisma.openBankingSyncRun.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.openBankingConnection.deleteMany({
      where: {
        companyId,
      },
    });

    await prisma.account.deleteMany({
      where: {
        companyId,
      },
    });
  }

  if (userId) {
    await prisma.auditLog.updateMany({
      where: {
        userId,
      },
      data: {
        userId: null,
      },
    });
  }

  if (companyId) {
    await prisma.auditLog.updateMany({
      where: {
        companyId,
      },
      data: {
        companyId: null,
      },
    });
  }

  if (userId) {
    await prisma.userCompanyMembership.deleteMany({
      where: {
        userId,
      },
    });

    await prisma.user.delete({
      where: {
        id: userId,
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
});

test('Open Banking: acceptă toate băncile din plan și setează providerul implicit', async () => {
  const cookieHeader = await loginWithCompanyContext();

  const expectedProviders = {
    BCR: 'BCR George Open Banking',
    BRD: 'BRD Open Banking',
    ING: 'ING Open Banking',
    RAIFFEISEN: 'Raiffeisen Open Banking',
    UNICREDIT: 'UniCredit Open Banking',
  } as const;

  const createdIds: string[] = [];
  for (const [bankCode, providerName] of Object.entries(expectedProviders)) {
    const createResponse = await fetch(`${baseUrl}/api/open-banking/connections`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        bankCode,
        accountCode: '5121',
        reason: `open-banking-integration-create-${bankCode.toLowerCase()}`,
      }),
    });

    assert.equal(createResponse.status, 201, `Crearea conexiunii pentru ${bankCode} trebuie să returneze 201`);
    const created = (await createResponse.json()) as {
      id: string;
      bankCode: string;
      providerName: string;
      status: string;
    };
    createdIds.push(created.id);

    assert.equal(created.bankCode, bankCode);
    assert.equal(created.providerName, providerName);
    assert.equal(created.status, 'PENDING');
  }

  const listResponse = await fetch(`${baseUrl}/api/open-banking/connections`, {
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(listResponse.status, 200);
  const connections = (await listResponse.json()) as Array<{ id: string; bankCode: string; providerName: string }>;
  const listedIds = new Set(connections.map((connection) => connection.id));
  for (const createdId of createdIds) {
    assert.equal(listedIds.has(createdId), true, 'Conexiunea creată trebuie să fie listată în endpoint-ul de conexiuni');
  }
});
