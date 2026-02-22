import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { Prisma, Role } from '@prisma/client';
import { generateSecret, generateSync } from 'otplib';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'JournalFlow!Pass2026';

let server: Server | null = null;
let baseUrl = '';
let companyId: string | null = null;
let userId: string | null = null;
let userEmail = '';
let mfaSecret = '';
let debitAccountId: string | null = null;
let creditAccountId: string | null = null;

function extractCookieHeader(response: Response): string {
  const rawCookies = response.headers.getSetCookie();
  return rawCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie && cookie.length > 0))
    .join('; ');
}

async function loginAndGetCookieHeader(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: userEmail,
      password: PASSWORD,
      mfaCode: generateSync({ secret: mfaSecret }),
    }),
  });
  assert.equal(response.status, 200, `Autentificarea a eșuat cu status ${response.status}`);
  return extractCookieHeader(response);
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server?.on('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const createdCompany = await prisma.company.create({
    data: {
      code: `journal-${RUN_ID}`,
      name: `Journal Workflow ${RUN_ID}`,
      isActive: true,
    },
  });
  companyId = createdCompany.id;

  userEmail = `journal-${RUN_ID}@sega.test`;
  mfaSecret = generateSecret();
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email: userEmail,
      name: 'Journal Workflow Admin',
      passwordHash,
      role: Role.ADMIN,
      mustChangePassword: false,
      mfaEnabled: true,
      mfaSecret,
    },
  });
  userId = user.id;

  await prisma.userCompanyMembership.create({
    data: {
      userId: user.id,
      companyId: createdCompany.id,
      role: Role.ADMIN,
      isDefault: true,
    },
  });

  const accounts = await prisma.$transaction([
    prisma.account.create({
      data: {
        companyId: createdCompany.id,
        code: `101-${RUN_ID.slice(-4)}`,
        name: 'Cont debit test jurnal',
        type: 'ASSET',
        currency: 'RON',
      },
    }),
    prisma.account.create({
      data: {
        companyId: createdCompany.id,
        code: `401-${RUN_ID.slice(-4)}`,
        name: 'Cont credit test jurnal',
        type: 'LIABILITY',
        currency: 'RON',
      },
    }),
  ]);

  debitAccountId = accounts[0]?.id ?? null;
  creditAccountId = accounts[1]?.id ?? null;
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
    await prisma.journalLine.deleteMany({
      where: {
        entry: {
          companyId,
        },
      },
    });
    await prisma.journalEntry.deleteMany({
      where: { companyId },
    });
    await prisma.accountingPeriod.deleteMany({
      where: { companyId },
    });
    await prisma.account.deleteMany({
      where: { companyId },
    });
    await prisma.auditLog.deleteMany({
      where: { companyId },
    });
    await prisma.auditLog.updateMany({
      where: { companyId },
      data: { companyId: null },
    });
    try {
      await prisma.company.delete({
        where: { id: companyId },
      });
    } catch (error) {
      const isForeignKeyCleanupError =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
      if (!isForeignKeyCleanupError) {
        throw error;
      }
    }
  }

  if (userId) {
    await prisma.refreshSession.deleteMany({
      where: { userId },
    });
    await prisma.userCompanyMembership.deleteMany({
      where: { userId },
    });
    await prisma.user.delete({
      where: { id: userId },
    });
  }
});

test('jurnal: create draft, validate și storno cu legătură la nota originală', async () => {
  assert.ok(debitAccountId, 'Cont debit lipsă');
  assert.ok(creditAccountId, 'Cont credit lipsă');

  const cookieHeader = await loginAndGetCookieHeader();
  const createResponse = await fetch(`${baseUrl}/api/journal-entries`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      date: '2026-02-11T09:00:00.000Z',
      description: 'Notă jurnal test workflow',
      lines: [
        {
          accountId: debitAccountId,
          debit: 1250,
          credit: 0,
        },
        {
          accountId: creditAccountId,
          debit: 0,
          credit: 1250,
        },
      ],
      sourceModule: 'GENERAL_LEDGER',
    }),
  });
  assert.equal(createResponse.status, 201);
  const createdPayload = (await createResponse.json()) as {
    id: string;
    number: string;
    status: string;
    posted: boolean;
  };
  assert.match(createdPayload.number, /^NC-\d{4}-\d{6}$/);
  assert.equal(createdPayload.status, 'DRAFT');
  assert.equal(createdPayload.posted, false);

  const validateResponse = await fetch(`${baseUrl}/api/journal-entries/${createdPayload.id}/validate`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(validateResponse.status, 200);
  const validatedPayload = (await validateResponse.json()) as {
    id: string;
    status: string;
    posted: boolean;
  };
  assert.equal(validatedPayload.id, createdPayload.id);
  assert.equal(validatedPayload.status, 'VALIDATED');
  assert.equal(validatedPayload.posted, true);

  const stornoResponse = await fetch(`${baseUrl}/api/journal-entries/${createdPayload.id}/storno`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      date: '2026-02-12T09:00:00.000Z',
      description: 'Storno test workflow',
    }),
  });
  assert.equal(stornoResponse.status, 201);
  const stornoPayload = (await stornoResponse.json()) as {
    id: string;
    number: string;
    status: string;
    reversalOfEntryId: string;
    lines: Array<{
      accountId: string;
      debit: string;
      credit: string;
    }>;
  };
  assert.notEqual(stornoPayload.id, createdPayload.id);
  assert.equal(stornoPayload.status, 'VALIDATED');
  assert.equal(stornoPayload.reversalOfEntryId, createdPayload.id);
  assert.match(stornoPayload.number, /^NC-\d{4}-\d{6}$/);

  const reversedDebitLine = stornoPayload.lines.find((line) => line.accountId === debitAccountId);
  const reversedCreditLine = stornoPayload.lines.find((line) => line.accountId === creditAccountId);
  assert.equal(Number(reversedDebitLine?.debit ?? 0), 0);
  assert.equal(Number(reversedDebitLine?.credit ?? 0), 1250);
  assert.equal(Number(reversedCreditLine?.debit ?? 0), 1250);
  assert.equal(Number(reversedCreditLine?.credit ?? 0), 0);

  const secondStornoResponse = await fetch(`${baseUrl}/api/journal-entries/${createdPayload.id}/storno`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(secondStornoResponse.status, 409);
});

test('period close: blochează perioade cu draft și marchează notele validate ca CLOSED', async () => {
  assert.ok(debitAccountId, 'Cont debit lipsă');
  assert.ok(creditAccountId, 'Cont credit lipsă');

  const cookieHeader = await loginAndGetCookieHeader();
  const createResponse = await fetch(`${baseUrl}/api/journal-entries`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      date: '2026-03-05T10:00:00.000Z',
      description: 'Draft care blochează period close',
      lines: [
        {
          accountId: debitAccountId,
          debit: 500,
          credit: 0,
        },
        {
          accountId: creditAccountId,
          debit: 0,
          credit: 500,
        },
      ],
    }),
  });
  assert.equal(createResponse.status, 201);
  const draftEntry = (await createResponse.json()) as { id: string; period: string };
  assert.equal(draftEntry.period, '2026-03');

  const closeBlockedResponse = await fetch(`${baseUrl}/api/periods/2026-03/close`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'journal-period-test' }),
  });
  assert.equal(closeBlockedResponse.status, 409);

  const validateResponse = await fetch(`${baseUrl}/api/journal-entries/${draftEntry.id}/validate`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'ready-for-close' }),
  });
  assert.equal(validateResponse.status, 200);

  const closeResponse = await fetch(`${baseUrl}/api/periods/2026-03/close`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'journal-period-test' }),
  });
  assert.equal(closeResponse.status, 200);

  const entriesResponse = await fetch(`${baseUrl}/api/journal-entries`, {
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(entriesResponse.status, 200);
  const entriesPayload = (await entriesResponse.json()) as Array<{ id: string; status: string }>;
  const closedEntry = entriesPayload.find((entry) => entry.id === draftEntry.id);
  assert.equal(closedEntry?.status, 'CLOSED');

  const reopenResponse = await fetch(`${baseUrl}/api/periods/2026-03/reopen`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'journal-period-test-reopen' }),
  });
  assert.equal(reopenResponse.status, 200);

  const entriesAfterReopenResponse = await fetch(`${baseUrl}/api/journal-entries`, {
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(entriesAfterReopenResponse.status, 200);
  const entriesAfterReopen = (await entriesAfterReopenResponse.json()) as Array<{ id: string; status: string }>;
  const reopenedEntry = entriesAfterReopen.find((entry) => entry.id === draftEntry.id);
  assert.equal(reopenedEntry?.status, 'VALIDATED');
});
