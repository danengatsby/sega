import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Role } from '@prisma/client';
import { bindDbRequestContext } from './db-context.js';
import { errorHandler } from './error.js';
import { prisma } from '../lib/prisma.js';

let server: Server | null = null;
let baseUrl = '';

before(async () => {
  const app = express();
  const testCompanyId = randomUUID();
  const testUserId = randomUUID();

  app.use((req, _res, next) => {
    req.user = {
      id: testUserId,
      email: 'db-context@test.local',
      role: Role.ADMIN,
      companyRole: Role.ADMIN,
      name: 'DB Context Tester',
      mustChangePassword: false,
      mfaEnabled: true,
      companyId: testCompanyId,
      sessionId: randomUUID(),
    };
    next();
  });

  app.use(bindDbRequestContext);

  app.get('/probe', async (_req, res, next) => {
    try {
      const rows = await prisma.$queryRaw<Array<{ company_id: string | null }>>`
        SELECT NULLIF(current_setting('app.company_id', true), '') AS company_id
      `;
      res.json({
        companyId: rows[0]?.company_id ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server?.on('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

test('bindDbRequestContext setează contextul companiei în sesiunea DB', async () => {
  const response = await fetch(`${baseUrl}/probe`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { companyId: string | null };
  assert.ok(payload.companyId, 'companyId trebuie să fie setat în contextul DB al request-ului');
});

test('bindDbRequestContext blochează request-urile fără companyId', async () => {
  const app = express();
  const testUserId = randomUUID();

  app.use((req, _res, next) => {
    req.user = {
      id: testUserId,
      email: 'db-context-missing@test.local',
      role: Role.ADMIN,
      companyRole: Role.ADMIN,
      name: 'DB Context Missing Company',
      mustChangePassword: false,
      mfaEnabled: true,
    };
    next();
  });

  app.use(bindDbRequestContext);
  app.get('/probe', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  const isolatedServer = app.listen(0);
  await new Promise<void>((resolve) => {
    isolatedServer.on('listening', () => resolve());
  });
  const address = isolatedServer.address() as AddressInfo;
  const isolatedBaseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${isolatedBaseUrl}/probe`);
    assert.equal(response.status, 403);
    const payload = (await response.json()) as { message?: string };
    assert.equal(payload.message, 'Context companie lipsă pentru request-ul curent.');
  } finally {
    await new Promise<void>((resolve, reject) => {
      isolatedServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
