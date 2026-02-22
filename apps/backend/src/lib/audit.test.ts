import assert from 'node:assert/strict';
import test from 'node:test';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { writeAudit } from './audit.js';

interface CapturedCreateArgs {
  data: Record<string, unknown>;
}

function buildRequest(): Request {
  return {
    ip: '203.0.113.10',
    headers: {
      'user-agent': 'audit-test-agent',
    },
    user: {
      id: '2adabf95-cf85-4373-a6ec-12b60566a7fb',
      email: 'auditor@example.com',
      role: Role.ADMIN,
      companyRole: Role.CHIEF_ACCOUNTANT,
      sessionId: '8d1f2ca7-3250-4c77-ae50-f5575107c9e7',
      name: 'Audit User',
      mustChangePassword: false,
      mfaEnabled: true,
      companyId: 'd47b8eaf-6218-4044-b8a3-15f2df8ec51b',
    },
  } as unknown as Request;
}

test('writeAudit populeaza campurile extinse audit', async () => {
  const captured: CapturedCreateArgs[] = [];
  const db = {
    auditLog: {
      async create(args: CapturedCreateArgs): Promise<CapturedCreateArgs> {
        captured.push(args);
        return args;
      },
    },
  };

  const before = { status: 'DRAFT' };
  const after = { status: 'ISSUED' };
  await writeAudit(
    buildRequest(),
    {
      tableName: 'invoices',
      recordId: '2f011067-d4f5-49cb-8fd9-876116d04620',
      action: 'UPDATE',
      reason: 'Flux test',
      beforeData: before,
      afterData: after,
    },
    db as any,
  );

  assert.equal(captured.length, 1);
  const { data } = captured[0]!;

  assert.equal(data.userId, '2adabf95-cf85-4373-a6ec-12b60566a7fb');
  assert.equal(data.userEmail, 'auditor@example.com');
  assert.equal(data.userRole, Role.CHIEF_ACCOUNTANT);
  assert.equal(data.sessionId, '8d1f2ca7-3250-4c77-ae50-f5575107c9e7');
  assert.deepEqual(data.oldValues, before);
  assert.deepEqual(data.newValues, after);
  assert.deepEqual(data.beforeData, before);
  assert.deepEqual(data.afterData, after);
});

test('writeAudit face fallback pe schema legacy cand lipsesc coloane noi', async () => {
  const captured: CapturedCreateArgs[] = [];
  let attempts = 0;
  const db = {
    auditLog: {
      async create(args: CapturedCreateArgs): Promise<CapturedCreateArgs> {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('The column `userEmail` does not exist in the current database.');
        }

        captured.push(args);
        return args;
      },
    },
  };

  const before = { status: 'DRAFT' };
  const after = { status: 'ISSUED' };
  await writeAudit(
    buildRequest(),
    {
      tableName: 'invoices',
      recordId: '2f011067-d4f5-49cb-8fd9-876116d04620',
      action: 'UPDATE',
      reason: 'Legacy audit table',
      beforeData: before,
      afterData: after,
    },
    db as any,
  );

  assert.equal(attempts, 2);
  assert.equal(captured.length, 1);
  const { data } = captured[0]!;

  assert.equal(data.userId, '2adabf95-cf85-4373-a6ec-12b60566a7fb');
  assert.equal('userEmail' in data, false);
  assert.equal('sessionId' in data, false);
  assert.equal('oldValues' in data, false);
  assert.equal('newValues' in data, false);
  assert.deepEqual(data.beforeData, before);
  assert.deepEqual(data.afterData, after);
});
