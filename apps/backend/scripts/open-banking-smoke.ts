import 'dotenv/config';

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { Role } from '@prisma/client';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'OpenBanking!Smoke2026';

let mockServer: Server | null = null;
let appServer: Server | null = null;
let prisma: Awaited<typeof import('../src/lib/prisma.js')>['prisma'] | null = null;
let stopOpenBankingScheduler: (() => void) | null = null;
let companyId: string | null = null;
let userId: string | null = null;
let connectionId: string | null = null;
let apiBase = '';

const cookieJar = new Map<string, string>();

function log(message: string): void {
  console.log(`[open-banking-smoke] ${message}`);
}

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startMockBank(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (method === 'POST' && url.pathname === '/oauth2/token') {
      const body = await readRequestBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');
      const clientId = params.get('client_id');
      const clientSecret = params.get('client_secret');

      if (clientId !== 'mock-client' || clientSecret !== 'mock-secret') {
        jsonResponse(res, 401, {
          error: 'invalid_client',
          error_description: 'Client credentials invalide.',
        });
        return;
      }

      if (grantType === 'authorization_code') {
        if (params.get('code') !== 'mock-auth-code') {
          jsonResponse(res, 400, {
            error: 'invalid_grant',
            error_description: 'Authorization code invalid.',
          });
          return;
        }

        jsonResponse(res, 200, {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'accounts transactions',
        });
        return;
      }

      if (grantType === 'refresh_token') {
        if (params.get('refresh_token') !== 'mock-refresh-token') {
          jsonResponse(res, 400, {
            error: 'invalid_grant',
            error_description: 'Refresh token invalid.',
          });
          return;
        }

        jsonResponse(res, 200, {
          access_token: 'mock-access-token-refreshed',
          refresh_token: 'mock-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'accounts transactions',
        });
        return;
      }

      jsonResponse(res, 400, {
        error: 'unsupported_grant_type',
        error_description: `Grant type neacceptat: ${grantType ?? '<missing>'}`,
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/open-banking/accounts') {
      const authorization = req.headers.authorization ?? '';
      if (!authorization.startsWith('Bearer ')) {
        jsonResponse(res, 401, {
          error: 'unauthorized',
          error_description: 'Bearer token lipsă.',
        });
        return;
      }

      jsonResponse(res, 200, {
        accounts: [
          {
            id: 'acc-main-ron',
            iban: 'RO49AAAA1B31007593840000',
            currency: 'RON',
            balance: {
              amount: '12500.42',
              currency: 'RON',
            },
            name: 'Cont curent principal',
          },
        ],
      });
      return;
    }

    const transactionPathMatch = url.pathname.match(/^\/open-banking\/accounts\/([^/]+)\/transactions$/);
    if (method === 'GET' && transactionPathMatch) {
      const authorization = req.headers.authorization ?? '';
      if (!authorization.startsWith('Bearer ')) {
        jsonResponse(res, 401, {
          error: 'unauthorized',
          error_description: 'Bearer token lipsă.',
        });
        return;
      }

      const accountId = decodeURIComponent(transactionPathMatch[1] ?? '');
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const fromDate = url.searchParams.get('fromDate');
      const toDate = url.searchParams.get('toDate');

      jsonResponse(res, 200, {
        accountId,
        fromDate,
        toDate,
        transactions: [
          {
            id: 'tx-ob-001',
            bookingDate: `${yesterday}T09:00:00.000Z`,
            amount: {
              value: '100.50',
              currency: 'RON',
            },
            creditDebitIndicator: 'CRDT',
            remittanceInformationUnstructured: 'Incasare factura INV-001',
            reference: 'INV-001',
            counterpartyName: 'Client Demo SRL',
            counterpartyIban: 'RO49AAAA1B31007593840000',
          },
          {
            id: 'tx-ob-002',
            bookingDate: `${today}T11:30:00.000Z`,
            amount: {
              value: '200.00',
              currency: 'RON',
            },
            creditDebitIndicator: 'CRDT',
            remittanceInformationUnstructured: 'Incasare factura INV-002',
            reference: 'INV-002',
            counterpartyName: 'Client Demo SRL',
            counterpartyIban: 'RO49AAAA1B31007593840000',
          },
        ],
      });
      return;
    }

    jsonResponse(res, 404, {
      error: 'not_found',
      message: `${method} ${url.pathname} nu există în banca mock.`,
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function configureOpenBankingEnv(mockBankBaseUrl: string): void {
  const hourUtc = String(new Date().getUTCHours());
  process.env.OPEN_BANKING_ENABLED = 'true';
  process.env.OPEN_BANKING_PILOT_BANK = 'bcr';
  process.env.OPEN_BANKING_DAILY_SYNC_HOUR_UTC = hourUtc;
  process.env.OPEN_BANKING_BCR_TOKEN_URL = `${mockBankBaseUrl}/oauth2/token`;
  process.env.OPEN_BANKING_BCR_ACCOUNTS_URL = `${mockBankBaseUrl}/open-banking/accounts`;
  process.env.OPEN_BANKING_BCR_TRANSACTIONS_URL = `${mockBankBaseUrl}/open-banking/accounts/{accountId}/transactions`;
  process.env.OPEN_BANKING_BCR_CLIENT_ID = 'mock-client';
  process.env.OPEN_BANKING_BCR_CLIENT_SECRET = 'mock-secret';
}

function captureCookies(response: Response): void {
  for (const setCookie of response.headers.getSetCookie()) {
    const rawCookie = setCookie.split(';')[0];
    if (!rawCookie) {
      continue;
    }

    const separatorIndex = rawCookie.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const name = rawCookie.slice(0, separatorIndex).trim();
    const value = rawCookie.slice(separatorIndex + 1).trim();

    if (!name) {
      continue;
    }

    if (!value) {
      cookieJar.delete(name);
      continue;
    }

    cookieJar.set(name, value);
  }
}

function cookieHeader(): string | null {
  if (cookieJar.size === 0) {
    return null;
  }
  return Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const cookie = cookieHeader();
  if (cookie) {
    headers.set('cookie', cookie);
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
  });
  captureCookies(response);
  return response;
}

async function postJson(path: string, payload: unknown): Promise<Response> {
  return request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Răspuns JSON invalid (${response.status}): ${text.slice(0, 500)}`);
  }
}

async function stopServer(server: Server | null): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timeout după ${timeoutMs}ms: condiția nu a fost îndeplinită.`);
}

async function cleanupData(): Promise<void> {
  if (!prisma) {
    return;
  }

  const safe = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[open-banking-smoke] Cleanup warning (${label}): ${message}`);
    }
  };

  if (companyId) {
    await safe('delete sync runs', async () => {
      await prisma!.openBankingSyncRun.deleteMany({
        where: { companyId: companyId! },
      });
    });
    await safe('delete connections', async () => {
      await prisma!.openBankingConnection.deleteMany({
        where: { companyId: companyId! },
      });
    });
    await safe('delete statement lines', async () => {
      await prisma!.bankStatementLine.deleteMany({
        where: { companyId: companyId! },
      });
    });
    await safe('delete statements', async () => {
      await prisma!.bankStatement.deleteMany({
        where: { companyId: companyId! },
      });
    });
  }

  if (userId) {
    await safe('delete refresh sessions', async () => {
      await prisma!.refreshSession.deleteMany({ where: { userId: userId! } });
    });
  }
}

async function main(): Promise<void> {
  const mock = await startMockBank();
  mockServer = mock.server;
  configureOpenBankingEnv(mock.baseUrl);

  const [{ createApp }, prismaModule, schedulerModule] = await Promise.all([
    import('../src/app.js'),
    import('../src/lib/prisma.js'),
    import('../src/services/open-banking/scheduler.js'),
  ]);

  prisma = prismaModule.prisma;
  stopOpenBankingScheduler = schedulerModule.stopOpenBankingScheduler;

  appServer = createApp().listen(0);
  await new Promise<void>((resolve) => {
    appServer?.on('listening', () => resolve());
  });
  const appAddress = appServer.address() as AddressInfo;
  apiBase = `http://127.0.0.1:${appAddress.port}`;

  log(`Banca mock pornită la ${mock.baseUrl}`);
  log(`API backend pornit la ${apiBase}`);

  const company = await prisma.company.create({
    data: {
      code: `ob-smoke-${RUN_ID}`,
      name: `Open Banking Smoke ${RUN_ID}`,
      isActive: true,
    },
  });
  companyId = company.id;

  const email = `open-banking-smoke-${RUN_ID}@sega.test`;
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email,
      name: 'Open Banking Smoke User',
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

  await prisma.account.create({
    data: {
      companyId: company.id,
      code: '5121',
      name: 'Conturi la bănci în lei',
      type: 'ASSET',
      currency: 'RON',
      isActive: true,
    },
  });

  const loginResponse = await postJson('/api/auth/login', {
    email,
    password: PASSWORD,
  });
  assert.equal(loginResponse.status, 200, `Login a eșuat (${loginResponse.status})`);

  const switchCompanyResponse = await postJson('/api/auth/switch-company', {
    companyId: company.id,
    makeDefault: true,
    reason: 'smoke-open-banking-initial-company-selection',
  });
  assert.equal(
    switchCompanyResponse.status,
    200,
    `Selectarea companiei active a eșuat (${switchCompanyResponse.status})`,
  );

  const createConnectionResponse = await postJson('/api/open-banking/connections', {
    bankCode: 'BCR',
    accountCode: '5121',
    reason: 'smoke-open-banking',
  });
  assert.equal(createConnectionResponse.status, 201, `Crearea conexiunii a eșuat (${createConnectionResponse.status})`);

  const createdConnection = await parseJson<{ id: string; status: string }>(createConnectionResponse);
  connectionId = createdConnection.id;
  assert.equal(createdConnection.status, 'PENDING');

  const tokenExchangeResponse = await postJson(`/api/open-banking/connections/${connectionId}/oauth2/token`, {
    authorizationCode: 'mock-auth-code',
    reason: 'smoke-open-banking',
  });
  assert.equal(tokenExchangeResponse.status, 200, `Token exchange a eșuat (${tokenExchangeResponse.status})`);

  const syncResponse = await postJson(`/api/open-banking/connections/${connectionId}/sync`, {
    reason: 'smoke-open-banking',
  });
  assert.equal(syncResponse.status, 201, `Sync manual a eșuat (${syncResponse.status})`);

  const syncPayload = await parseJson<{
    transactionsImported: number;
    balancesSynced: number;
  }>(syncResponse);
  assert.ok(syncPayload.transactionsImported >= 1, 'Sync manual nu a importat tranzacții.');
  assert.ok(syncPayload.balancesSynced >= 1, 'Sync manual nu a sincronizat solduri.');

  const linesImported = await prisma.bankStatementLine.count({
    where: { companyId: company.id },
  });
  assert.ok(linesImported >= 1, 'Nu există linii de extras importate după sync manual.');

  const syncRunsAfterManual = await prisma.openBankingSyncRun.findMany({
    where: {
      companyId: company.id,
      connectionId,
    },
    orderBy: {
      startedAt: 'desc',
    },
  });
  assert.ok(syncRunsAfterManual.some((run) => run.status === 'SUCCESS' && run.initiatedByUserId === user.id));

  await prisma.openBankingConnection.update({
    where: { id: connectionId },
    data: {
      lastSyncedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    },
  });

  schedulerModule.startOpenBankingScheduler();

  await waitFor(async () => {
    const schedulerRuns = await prisma!.openBankingSyncRun.count({
      where: {
        companyId: company.id,
        connectionId,
        initiatedByUserId: null,
        status: 'SUCCESS',
      },
    });
    return schedulerRuns >= 1;
  }, 8_000);

  const runsResponse = await request(`/api/open-banking/connections/${connectionId}/sync-runs?take=10`);
  assert.equal(runsResponse.status, 200, `Citirea sync runs a eșuat (${runsResponse.status})`);
  const runsPayload = await parseJson<Array<{ status: string; initiatedByUserId: string | null }>>(runsResponse);
  assert.ok(runsPayload.some((run) => run.status === 'SUCCESS' && run.initiatedByUserId === null));

  log('Flux E2E Open Banking validat: create connection -> OAuth2 -> sync manual -> sync scheduler.');
  log('OPEN BANKING SMOKE PASSED');
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[open-banking-smoke] FAILED: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    stopOpenBankingScheduler?.();
    await cleanupData();
    await stopServer(appServer);
    await stopServer(mockServer);
    await prisma?.$disconnect();
  });
