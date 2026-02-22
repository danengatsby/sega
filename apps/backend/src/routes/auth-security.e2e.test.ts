import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { generateSecret, generateSync } from 'otplib';
import { createApp } from '../app.js';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'AuthSecurity!Pass2026';
const COMPANY_CODE = `auth-sec-${RUN_ID}`;
const COMPANY_NAME = `Auth Security ${RUN_ID}`;

interface FixtureUser {
  id: string;
  email: string;
  role: Role;
  mfaSecret: string | null;
}

let server: Server | null = null;
let baseUrl = '';
let companyId: string | null = null;
let userForRateLimit: FixtureUser | null = null;
let chiefAccountant: FixtureUser | null = null;
let adminWithMfa: FixtureUser | null = null;

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = createApp();
  const localServer = app.listen(0);
  await new Promise<void>((resolve) => {
    localServer.on('listening', () => resolve());
  });

  const address = localServer.address() as AddressInfo;
  return {
    server: localServer,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(target: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function extractCookieHeader(response: Response): string {
  const rawCookies = response.headers.getSetCookie();
  return rawCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie && cookie.length > 0))
    .join('; ');
}

async function login(email: string, options: { password?: string; mfaCode?: string } = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password: options.password ?? PASSWORD,
      ...(options.mfaCode ? { mfaCode: options.mfaCode } : {}),
    }),
  });
}

before(async () => {
  const started = await startServer();
  server = started.server;
  baseUrl = started.baseUrl;

  const company = await prisma.company.create({
    data: {
      code: COMPANY_CODE,
      name: COMPANY_NAME,
      isActive: true,
    },
  });
  companyId = company.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const users = await prisma.$transaction(async (tx) => {
    const rateUser = await tx.user.create({
      data: {
        email: `rate-${RUN_ID}@sega.test`,
        name: 'Rate Limit User',
        passwordHash,
        mustChangePassword: false,
        role: Role.ACCOUNTANT,
      },
    });
    await tx.userCompanyMembership.create({
      data: {
        userId: rateUser.id,
        companyId: company.id,
        role: Role.ACCOUNTANT,
        isDefault: true,
      },
    });

    const chiefUser = await tx.user.create({
      data: {
        email: `chief-${RUN_ID}@sega.test`,
        name: 'Chief Accountant User',
        passwordHash,
        mustChangePassword: false,
        role: Role.CHIEF_ACCOUNTANT,
      },
    });
    await tx.userCompanyMembership.create({
      data: {
        userId: chiefUser.id,
        companyId: company.id,
        role: Role.CHIEF_ACCOUNTANT,
        isDefault: true,
      },
    });

    const adminSecret = generateSecret();
    const adminUser = await tx.user.create({
      data: {
        email: `admin-${RUN_ID}@sega.test`,
        name: 'Admin MFA User',
        passwordHash,
        mustChangePassword: false,
        role: Role.ADMIN,
        mfaEnabled: true,
        mfaSecret: adminSecret,
      },
    });
    await tx.userCompanyMembership.create({
      data: {
        userId: adminUser.id,
        companyId: company.id,
        role: Role.ADMIN,
        isDefault: true,
      },
    });

    return {
      rateUser: { ...rateUser, mfaSecret: null },
      chiefUser: { ...chiefUser, mfaSecret: null },
      adminUser: { ...adminUser, mfaSecret: adminSecret },
    };
  });

  userForRateLimit = users.rateUser;
  chiefAccountant = users.chiefUser;
  adminWithMfa = users.adminUser;
});

after(async () => {
  if (server) {
    await stopServer(server);
  }

  const users = [userForRateLimit, chiefAccountant, adminWithMfa].filter(
    (user): user is FixtureUser => Boolean(user),
  );
  const userIds = users.map((user) => user.id);

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
      where: { id: companyId },
    });
  }
});

test('login limiter blochează a (max + 1)-a încercare în aceeași fereastră', async () => {
  assert.ok(userForRateLimit, 'Fixture user lipsă pentru testul de rate-limit');
  const isolated = await startServer();

  try {
    const isolatedBaseUrl = isolated.baseUrl;
    for (let attempt = 0; attempt < env.RATE_LIMIT_MAX_LOGIN; attempt += 1) {
      const response = await fetch(`${isolatedBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: userForRateLimit.email,
          password: `${PASSWORD}-wrong`,
        }),
      });

      assert.notEqual(response.status, 429, `Încercarea ${attempt + 1} a fost blocată prea devreme`);
    }

    const blockedResponse = await fetch(`${isolatedBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: userForRateLimit.email,
        password: `${PASSWORD}-wrong`,
      }),
    });

    assert.equal(blockedResponse.status, 429, 'A (max + 1)-a încercare trebuie blocată cu 429');
    const payload = (await blockedResponse.json()) as { code?: string };
    assert.equal(payload.code, 'LOGIN_RATE_LIMIT_EXCEEDED');
  } finally {
    await stopServer(isolated.server);
  }
});

test('login pentru cont cu MFA activ necesită cod valid', async () => {
  assert.ok(adminWithMfa?.mfaSecret, 'Fixture admin MFA lipsă');

  const noCodeResponse = await login(adminWithMfa.email);
  assert.equal(noCodeResponse.status, 401);
  const noCodePayload = (await noCodeResponse.json()) as { code?: string };
  assert.equal(noCodePayload.code, 'MFA_CODE_REQUIRED');

  const invalidCodeResponse = await login(adminWithMfa.email, {
    mfaCode: '000000',
  });
  assert.equal(invalidCodeResponse.status, 401);
  const invalidCodePayload = (await invalidCodeResponse.json()) as { code?: string };
  assert.equal(invalidCodePayload.code, 'MFA_INVALID_CODE');

  const validCode = generateSync({ secret: adminWithMfa.mfaSecret });
  const successResponse = await login(adminWithMfa.email, {
    mfaCode: validCode,
  });
  assert.equal(successResponse.status, 200);
  const cookieHeader = extractCookieHeader(successResponse);
  assert.ok(cookieHeader.includes('sega_access_token='));
});

test('CHIEF_ACCOUNTANT fără MFA nu poate accesa rute protejate până la setup+verify', async () => {
  assert.ok(chiefAccountant, 'Fixture CHIEF_ACCOUNTANT lipsă');

  const loginResponse = await login(chiefAccountant.email);
  assert.equal(loginResponse.status, 200);
  let cookieHeader = extractCookieHeader(loginResponse);
  assert.ok(cookieHeader.includes('sega_access_token='));

  const blockedResponse = await fetch(`${baseUrl}/api/accounts`, {
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(blockedResponse.status, 403);
  const blockedPayload = (await blockedResponse.json()) as { code?: string };
  assert.equal(blockedPayload.code, 'MFA_SETUP_REQUIRED');

  const setupResponse = await fetch(`${baseUrl}/api/auth/mfa/setup`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(setupResponse.status, 200);
  const setupPayload = (await setupResponse.json()) as { secret: string; required: boolean };
  assert.equal(setupPayload.required, true);
  assert.ok(setupPayload.secret.length > 0);

  const badVerifyResponse = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      code: '000000',
    }),
  });
  assert.equal(badVerifyResponse.status, 401);
  const badVerifyPayload = (await badVerifyResponse.json()) as { code?: string };
  assert.equal(badVerifyPayload.code, 'MFA_INVALID_CODE');

  const validCode = generateSync({ secret: setupPayload.secret });
  const verifyResponse = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      code: validCode,
    }),
  });
  assert.equal(verifyResponse.status, 200);
  const verifyPayload = (await verifyResponse.json()) as { user: { mfaEnabled?: boolean } };
  assert.equal(verifyPayload.user.mfaEnabled, true);
  cookieHeader = extractCookieHeader(verifyResponse);
  assert.ok(cookieHeader.includes('sega_access_token='));

  const allowedResponse = await fetch(`${baseUrl}/api/accounts`, {
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(allowedResponse.status, 200);
});
