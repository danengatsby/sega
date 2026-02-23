import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'Revisal!Pass2026';
const TEST_PERIOD = '2026-02';

let server: Server | null = null;
let baseUrl = '';
let companyId: string | null = null;
let userId: string | null = null;
let userEmail = '';

function extractCookieHeader(response: Response): string {
  const rawCookies = response.headers.getSetCookie();
  return rawCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie && cookie.length > 0))
    .join('; ');
}

async function loginAndGetCookieHeader(): Promise<string> {
  assert.ok(companyId, 'Compania fixture lipsește pentru selecția obligatorie post-login');

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: userEmail,
      password: PASSWORD,
    }),
  });

  if (response.status !== 200) {
    const payload = await response.text();
    assert.fail(`Autentificarea a eșuat (${response.status}): ${payload}`);
  }

  const loginCookieHeader = extractCookieHeader(response);
  const switchResponse = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      companyId,
      makeDefault: true,
      reason: 'revisal-integration-initial-company-selection',
    }),
  });

  if (switchResponse.status !== 200) {
    const payload = await switchResponse.text();
    assert.fail(`Selectarea companiei a eșuat (${switchResponse.status}): ${payload}`);
  }

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
      code: `revisal-${RUN_ID}`,
      name: `Revisal Integration ${RUN_ID}`,
      isActive: true,
    },
  });
  companyId = company.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  userEmail = `revisal-${RUN_ID}@sega.test`;
  const user = await prisma.user.create({
    data: {
      email: userEmail,
      name: 'Revisal Test Accountant',
      passwordHash,
      role: Role.ACCOUNTANT,
      mustChangePassword: false,
      mfaEnabled: false,
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

  await prisma.employee.createMany({
    data: [
      {
        companyId: company.id,
        cnp: '1960101223344',
        name: `Angajat Activ ${RUN_ID}`,
        contractType: 'CIM',
        grossSalary: 9000,
        personalDeduction: 0,
        isActive: true,
        hiredAt: new Date('2025-06-01T00:00:00.000Z'),
      },
      {
        companyId: company.id,
        cnp: '2950501223345',
        name: `Angajat Inactiv ${RUN_ID}`,
        contractType: 'MANDAT',
        grossSalary: 6500,
        personalDeduction: 0,
        isActive: false,
        hiredAt: new Date('2024-01-10T00:00:00.000Z'),
      },
    ],
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

  if (companyId) {
    await prisma.revisalDelivery.deleteMany({
      where: { companyId },
    });
    await prisma.employee.deleteMany({
      where: { companyId },
    });
    await prisma.auditLog.updateMany({
      where: { companyId },
      data: { companyId: null },
    });
    await prisma.company.update({
      where: { id: companyId },
      data: {
        isActive: false,
      },
    });
  }

  if (userId) {
    await prisma.refreshSession.deleteMany({
      where: { userId },
    });
    await prisma.userCompanyMembership.deleteMany({
      where: { userId },
    });
    await prisma.auditLog.updateMany({
      where: { userId },
      data: { userId: null },
    });
    await prisma.user.delete({
      where: { id: userId },
    });
  }
});

test('flux Revisal end-to-end: generate, list, detail, xml, deliver', async () => {
  const cookieHeader = await loginAndGetCookieHeader();
  const deliveryReference = `REV-${RUN_ID}`.slice(0, 40);

  const generateResponse = await fetch(`${baseUrl}/api/revisal/exports`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
    },
    body: JSON.stringify({
      period: TEST_PERIOD,
      deliveryReference,
      reason: 'integration-test-generate',
    }),
  });

  if (generateResponse.status !== 201) {
    const payload = await generateResponse.text();
    assert.fail(`Generarea Revisal a eșuat (${generateResponse.status}): ${payload}`);
  }

  const generatedPayload = (await generateResponse.json()) as {
    id: string;
    period: string;
    deliveryReference: string;
    status: string;
    employeeCount: number;
    xmlChecksum: string;
  };

  assert.equal(generatedPayload.period, TEST_PERIOD);
  assert.equal(generatedPayload.deliveryReference, deliveryReference);
  assert.equal(generatedPayload.status, 'GENERATED');
  assert.ok(generatedPayload.employeeCount >= 2);
  assert.match(generatedPayload.xmlChecksum, /^[a-f0-9]{64}$/);

  const listResponse = await fetch(`${baseUrl}/api/revisal/exports?period=${TEST_PERIOD}&limit=10`, {
    method: 'GET',
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(listResponse.status, 200);
  const listPayload = (await listResponse.json()) as Array<{ id: string; deliveryReference: string }>;
  assert.equal(listPayload.some((entry) => entry.id === generatedPayload.id), true);

  const detailsResponse = await fetch(`${baseUrl}/api/revisal/exports/${generatedPayload.id}`, {
    method: 'GET',
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(detailsResponse.status, 200);
  const detailsPayload = (await detailsResponse.json()) as {
    id: string;
    status: string;
    validationPerformed: boolean;
  };
  assert.equal(detailsPayload.id, generatedPayload.id);
  assert.equal(detailsPayload.status, 'GENERATED');
  assert.equal(typeof detailsPayload.validationPerformed, 'boolean');

  const xmlResponse = await fetch(`${baseUrl}/api/revisal/exports/${generatedPayload.id}/xml`, {
    method: 'GET',
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(xmlResponse.status, 200);
  assert.equal(xmlResponse.headers.get('content-type')?.includes('application/xml') ?? false, true);
  assert.equal(xmlResponse.headers.get('x-content-sha256'), generatedPayload.xmlChecksum);
  const xmlPayload = await xmlResponse.text();
  assert.match(xmlPayload, /<RevisalExport xmlns="urn:ro:itm:revisal:1.0">/);
  assert.match(xmlPayload, /<DeliveryReference>/);

  const deliverResponse = await fetch(`${baseUrl}/api/revisal/exports/${generatedPayload.id}/deliver`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
    },
    body: JSON.stringify({
      channel: 'WEB_PORTAL',
      receiptNumber: `REC-${RUN_ID}`.slice(0, 40),
      reason: 'integration-test-deliver',
    }),
  });
  assert.equal(deliverResponse.status, 200);
  const deliverPayload = (await deliverResponse.json()) as {
    id: string;
    status: string;
    channel: string;
    receiptNumber: string | null;
    deliveredAt: string;
  };
  assert.equal(deliverPayload.id, generatedPayload.id);
  assert.equal(deliverPayload.status, 'DELIVERED');
  assert.equal(deliverPayload.channel, 'WEB_PORTAL');
  assert.equal(deliverPayload.receiptNumber?.startsWith('REC-') ?? false, true);
  assert.equal(typeof deliverPayload.deliveredAt, 'string');
});
