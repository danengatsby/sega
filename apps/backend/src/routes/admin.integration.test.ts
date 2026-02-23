import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { generateSecret, generateSync } from 'otplib';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ADMIN_PASSWORD = 'AdminAudit!Pass2026';
const MANAGED_USER_PASSWORD = 'ManagedAudit!Pass2026';
const RESET_PASSWORD = 'ManagedAuditReset!Pass2026';

type HttpMethod = 'POST' | 'PATCH' | 'DELETE';

interface ExpectedActor {
  id: string;
  email: string;
  role: Role;
}

interface AuditSnapshotEnvelope {
  requestId: string | null;
  actor: {
    id: string | null;
    email: string | null;
    role: string | null;
    sessionId: string | null;
  };
  data: unknown;
}

let server: Server | null = null;
let baseUrl = '';
let adminCompanyId: string | null = null;
let adminUserId: string | null = null;
let adminEmail = '';
let adminMfaSecret = '';

let managedUserId: string | null = null;
let managedUserEmail = '';
let createdCompanyId: string | null = null;
const AUDIT_LOOKUP_MAX_ATTEMPTS = 8;
const AUDIT_LOOKUP_DELAY_MS = 60;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} trebuie să fie obiect.`);
  assert.notEqual(value, null, `${label} nu poate fi null.`);
  assert.equal(Array.isArray(value), false, `${label} nu poate fi array.`);
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  assert.equal(typeof value, 'string', `${label} trebuie să fie string sau null.`);
  return value as string;
}

function parseAuditSnapshot(value: unknown, label: string): AuditSnapshotEnvelope {
  const envelope = asRecord(value, label);
  const actorRaw = asRecord(envelope.actor, `${label}.actor`);

  return {
    requestId: asNullableString(envelope.requestId, `${label}.requestId`),
    actor: {
      id: asNullableString(actorRaw.id, `${label}.actor.id`),
      email: asNullableString(actorRaw.email, `${label}.actor.email`),
      role: asNullableString(actorRaw.role, `${label}.actor.role`),
      sessionId: asNullableString(actorRaw.sessionId, `${label}.actor.sessionId`),
    },
    data: envelope.data,
  };
}

function assertAuditMetadata(snapshot: AuditSnapshotEnvelope, expectedRequestId: string, expectedActor: ExpectedActor): void {
  assert.equal(snapshot.requestId, expectedRequestId, 'requestId din snapshot trebuie să coincidă cu header-ul cererii');
  assert.equal(snapshot.actor.id, expectedActor.id, 'actor.id invalid în snapshot');
  assert.equal(snapshot.actor.email, expectedActor.email, 'actor.email invalid în snapshot');
  assert.equal(snapshot.actor.role, expectedActor.role, 'actor.role invalid în snapshot');
  assert.equal(typeof snapshot.actor.sessionId, 'string', 'actor.sessionId trebuie să fie prezent');
  assert.ok((snapshot.actor.sessionId ?? '').length > 0, 'actor.sessionId nu poate fi gol');
}

function extractCookieHeader(response: Response): string {
  const rawCookies = response.headers.getSetCookie();
  return rawCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie && cookie.length > 0))
    .join('; ');
}

async function loginAdminAndGetCookieHeader(): Promise<string> {
  assert.ok(adminCompanyId, 'Compania admin fixture lipsește.');
  assert.ok(adminMfaSecret, 'Secret MFA admin lipsă.');

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: adminEmail,
      password: ADMIN_PASSWORD,
      mfaCode: generateSync({ secret: adminMfaSecret }),
    }),
  });

  if (loginResponse.status !== 200) {
    const payload = await loginResponse.text();
    assert.fail(`Login admin a eșuat (${loginResponse.status}): ${payload}`);
  }

  const loginCookieHeader = extractCookieHeader(loginResponse);
  const switchResponse = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      companyId: adminCompanyId,
      makeDefault: true,
      reason: 'admin-audit-integration-switch-company',
    }),
  });

  if (switchResponse.status !== 200) {
    const payload = await switchResponse.text();
    assert.fail(`Selectarea companiei admin a eșuat (${switchResponse.status}): ${payload}`);
  }

  return extractCookieHeader(switchResponse);
}

async function requestAdmin(
  cookieHeader: string,
  method: HttpMethod,
  path: string,
  requestId: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: cookieHeader,
    'x-request-id': requestId,
  };

  const init: RequestInit = {
    method,
    headers,
  };

  if (typeof body !== 'undefined') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  return fetch(`${baseUrl}${path}`, init);
}

async function loadAuditByActionAndRecord(
  action: string,
  recordId: string,
  actorUserId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof prisma.auditLog.findFirst>>>> {
  for (let attempt = 0; attempt < AUDIT_LOOKUP_MAX_ATTEMPTS; attempt += 1) {
    const [strictMatch, fallbackMatch] = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.enforce_rls', '0', true)`;

      const strict = await tx.auditLog.findFirst({
        where: {
          action,
          recordId,
          userId: actorUserId,
        },
        orderBy: [{ timestamp: 'desc' }],
      });

      const fallback = strict
        ? strict
        : await tx.auditLog.findFirst({
            where: {
              action,
              recordId,
            },
            orderBy: [{ timestamp: 'desc' }],
          });

      return [strict, fallback] as const;
    });

    const audit = strictMatch ?? fallbackMatch;
    if (!audit) {
      await sleep(AUDIT_LOOKUP_DELAY_MS * (attempt + 1));
      continue;
    }

    if (!strictMatch) {
      const beforeSnapshot = parseAuditSnapshot(audit.beforeData, `${action}.beforeData`);
      const afterSnapshot = parseAuditSnapshot(audit.afterData, `${action}.afterData`);
      const actorFromBefore = beforeSnapshot.actor.id;
      const actorFromAfter = afterSnapshot.actor.id;
      const actorMatches = actorFromBefore === actorUserId || actorFromAfter === actorUserId;
      if (!actorMatches) {
        await sleep(AUDIT_LOOKUP_DELAY_MS * (attempt + 1));
        continue;
      }
    }

    return audit;
  }

  assert.fail(`Audit log lipsă pentru action=${action}, recordId=${recordId}`);
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
      code: `admin-fixture-${RUN_ID}`.slice(0, 32),
      name: `Admin Fixture ${RUN_ID}`,
      isActive: true,
    },
  });
  adminCompanyId = company.id;

  adminEmail = `admin-audit-${RUN_ID}@sega.test`;
  adminMfaSecret = generateSecret();
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const adminUser = await prisma.user.create({
    data: {
      email: adminEmail,
      name: `Admin Audit ${RUN_ID}`,
      passwordHash,
      role: Role.ADMIN,
      mustChangePassword: false,
      mfaEnabled: true,
      mfaSecret: adminMfaSecret,
    },
  });
  adminUserId = adminUser.id;

  await prisma.userCompanyMembership.create({
    data: {
      userId: adminUser.id,
      companyId: company.id,
      role: Role.ADMIN,
      isDefault: true,
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

  const userIds = [adminUserId, managedUserId].filter((value): value is string => Boolean(value));
  const companyIds = [adminCompanyId, createdCompanyId].filter((value): value is string => Boolean(value));

  if (userIds.length > 0) {
    await prisma.refreshSession.deleteMany({
      where: {
        userId: {
          in: userIds,
        },
      },
    });
  }

  if (userIds.length > 0 || companyIds.length > 0) {
    await prisma.userCompanyMembership.deleteMany({
      where: {
        OR: [
          ...(userIds.length > 0
            ? [
                {
                  userId: {
                    in: userIds,
                  },
                },
              ]
            : []),
          ...(companyIds.length > 0
            ? [
                {
                  companyId: {
                    in: companyIds,
                  },
                },
              ]
            : []),
        ],
      },
    });
  }

  if (userIds.length > 0) {
    await prisma.auditLog.updateMany({
      where: {
        userId: {
          in: userIds,
        },
      },
      data: {
        userId: null,
      },
    });
  }

  if (companyIds.length > 0) {
    await prisma.auditLog.updateMany({
      where: {
        companyId: {
          in: companyIds,
        },
      },
      data: {
        companyId: null,
      },
    });
  }

  if (userIds.length > 0) {
    await prisma.user.deleteMany({
      where: {
        id: {
          in: userIds,
        },
      },
    });
  }

  if (companyIds.length > 0) {
    await prisma.company.updateMany({
      where: {
        id: {
          in: companyIds,
        },
      },
      data: {
        isActive: false,
      },
    });
  }
});

test('rutele admin scriu audit trail cu actor + before/after + requestId', async () => {
  assert.ok(adminUserId, 'Admin fixture user lipsă.');
  assert.ok(adminCompanyId, 'Admin fixture company lipsă.');

  const actor: ExpectedActor = {
    id: adminUserId,
    email: adminEmail,
    role: Role.ADMIN,
  };

  const cookieHeader = await loginAdminAndGetCookieHeader();

  const createCompanyRequestId = `admin-audit-company-create-${RUN_ID}`;
  const createCompanyResponse = await requestAdmin(cookieHeader, 'POST', '/api/admin/companies', createCompanyRequestId, {
    code: `audit-managed-${RUN_ID}`.slice(0, 32),
    name: `Audit Managed Company ${RUN_ID}`,
    country: 'RO',
    isActive: true,
  });
  if (createCompanyResponse.status !== 201) {
    const payload = await createCompanyResponse.text();
    assert.fail(`POST /api/admin/companies a eșuat (${createCompanyResponse.status}): ${payload}`);
  }

  const createdCompany = (await createCompanyResponse.json()) as {
    id: string;
    name: string;
  };
  createdCompanyId = createdCompany.id;

  const companyCreateAudit = await loadAuditByActionAndRecord('ADMIN_COMPANY_CREATE', createdCompany.id, adminUserId);
  assert.equal(companyCreateAudit.tableName, 'Company');
  const companyCreateBefore = parseAuditSnapshot(companyCreateAudit.beforeData, 'companyCreate.beforeData');
  const companyCreateAfter = parseAuditSnapshot(companyCreateAudit.afterData, 'companyCreate.afterData');
  assertAuditMetadata(companyCreateBefore, createCompanyRequestId, actor);
  assertAuditMetadata(companyCreateAfter, createCompanyRequestId, actor);
  assert.deepEqual(companyCreateBefore.data, { exists: false });
  const companyCreateAfterData = asRecord(companyCreateAfter.data, 'companyCreate.afterData.data');
  assert.equal(companyCreateAfterData.id, createdCompany.id);
  assert.equal(companyCreateAfterData.name, createdCompany.name);

  const updatedCompanyName = `Audit Managed Company Updated ${RUN_ID}`;
  const updateCompanyRequestId = `admin-audit-company-update-${RUN_ID}`;
  const updateCompanyResponse = await requestAdmin(
    cookieHeader,
    'PATCH',
    `/api/admin/companies/${createdCompany.id}`,
    updateCompanyRequestId,
    {
      name: updatedCompanyName,
    },
  );
  if (updateCompanyResponse.status !== 200) {
    const payload = await updateCompanyResponse.text();
    assert.fail(`PATCH /api/admin/companies/:id a eșuat (${updateCompanyResponse.status}): ${payload}`);
  }

  const companyUpdateAudit = await loadAuditByActionAndRecord('ADMIN_COMPANY_UPDATE', createdCompany.id, adminUserId);
  assert.equal(companyUpdateAudit.tableName, 'Company');
  const companyUpdateBefore = parseAuditSnapshot(companyUpdateAudit.beforeData, 'companyUpdate.beforeData');
  const companyUpdateAfter = parseAuditSnapshot(companyUpdateAudit.afterData, 'companyUpdate.afterData');
  assertAuditMetadata(companyUpdateBefore, updateCompanyRequestId, actor);
  assertAuditMetadata(companyUpdateAfter, updateCompanyRequestId, actor);
  const companyUpdateBeforeData = asRecord(companyUpdateBefore.data, 'companyUpdate.beforeData.data');
  const companyUpdateAfterData = asRecord(companyUpdateAfter.data, 'companyUpdate.afterData.data');
  assert.equal(companyUpdateBeforeData.name, createdCompany.name);
  assert.equal(companyUpdateAfterData.name, updatedCompanyName);

  managedUserEmail = `managed-admin-audit-${RUN_ID}@sega.test`;
  const createUserRequestId = `admin-audit-user-create-${RUN_ID}`;
  const createUserResponse = await requestAdmin(cookieHeader, 'POST', '/api/admin/users', createUserRequestId, {
    email: managedUserEmail,
    name: `Managed User ${RUN_ID}`,
    password: MANAGED_USER_PASSWORD,
    role: Role.ACCOUNTANT,
    memberships: [
      {
        companyId: adminCompanyId,
        role: Role.ACCOUNTANT,
        isDefault: true,
      },
    ],
  });
  if (createUserResponse.status !== 201) {
    const payload = await createUserResponse.text();
    assert.fail(`POST /api/admin/users a eșuat (${createUserResponse.status}): ${payload}`);
  }

  const createdUser = (await createUserResponse.json()) as {
    id: string;
    name: string;
    role: Role;
  };
  managedUserId = createdUser.id;

  const userCreateAudit = await loadAuditByActionAndRecord('ADMIN_USER_CREATE', createdUser.id, adminUserId);
  assert.equal(userCreateAudit.tableName, 'User');
  const userCreateBefore = parseAuditSnapshot(userCreateAudit.beforeData, 'userCreate.beforeData');
  const userCreateAfter = parseAuditSnapshot(userCreateAudit.afterData, 'userCreate.afterData');
  assertAuditMetadata(userCreateBefore, createUserRequestId, actor);
  assertAuditMetadata(userCreateAfter, createUserRequestId, actor);
  assert.deepEqual(userCreateBefore.data, { exists: false });
  const userCreateAfterData = asRecord(userCreateAfter.data, 'userCreate.afterData.data');
  assert.equal(userCreateAfterData.id, createdUser.id);
  assert.equal(userCreateAfterData.email, managedUserEmail);
  assert.equal(userCreateAfterData.role, Role.ACCOUNTANT);

  const updatedManagedUserName = `Managed User Updated ${RUN_ID}`;
  const updateUserRequestId = `admin-audit-user-update-${RUN_ID}`;
  const updateUserResponse = await requestAdmin(
    cookieHeader,
    'PATCH',
    `/api/admin/users/${createdUser.id}`,
    updateUserRequestId,
    {
      name: updatedManagedUserName,
      role: Role.MANAGER,
    },
  );
  if (updateUserResponse.status !== 200) {
    const payload = await updateUserResponse.text();
    assert.fail(`PATCH /api/admin/users/:id a eșuat (${updateUserResponse.status}): ${payload}`);
  }

  const userUpdateAudit = await loadAuditByActionAndRecord('ADMIN_USER_UPDATE', createdUser.id, adminUserId);
  assert.equal(userUpdateAudit.tableName, 'User');
  const userUpdateBefore = parseAuditSnapshot(userUpdateAudit.beforeData, 'userUpdate.beforeData');
  const userUpdateAfter = parseAuditSnapshot(userUpdateAudit.afterData, 'userUpdate.afterData');
  assertAuditMetadata(userUpdateBefore, updateUserRequestId, actor);
  assertAuditMetadata(userUpdateAfter, updateUserRequestId, actor);
  const userUpdateBeforeData = asRecord(userUpdateBefore.data, 'userUpdate.beforeData.data');
  const userUpdateAfterData = asRecord(userUpdateAfter.data, 'userUpdate.afterData.data');
  assert.equal(userUpdateBeforeData.name, createdUser.name);
  assert.equal(userUpdateAfterData.name, updatedManagedUserName);
  assert.equal(userUpdateBeforeData.role, Role.ACCOUNTANT);
  assert.equal(userUpdateAfterData.role, Role.MANAGER);

  const resetPasswordRequestId = `admin-audit-user-reset-${RUN_ID}`;
  const resetPasswordResponse = await requestAdmin(
    cookieHeader,
    'POST',
    `/api/admin/users/${createdUser.id}/reset-password`,
    resetPasswordRequestId,
    {
      newPassword: RESET_PASSWORD,
    },
  );
  if (resetPasswordResponse.status !== 200) {
    const payload = await resetPasswordResponse.text();
    assert.fail(`POST /api/admin/users/:id/reset-password a eșuat (${resetPasswordResponse.status}): ${payload}`);
  }

  const resetPasswordAudit = await loadAuditByActionAndRecord('ADMIN_USER_RESET_PASSWORD', createdUser.id, adminUserId);
  assert.equal(resetPasswordAudit.tableName, 'User');
  const resetPasswordBefore = parseAuditSnapshot(resetPasswordAudit.beforeData, 'resetPassword.beforeData');
  const resetPasswordAfter = parseAuditSnapshot(resetPasswordAudit.afterData, 'resetPassword.afterData');
  assertAuditMetadata(resetPasswordBefore, resetPasswordRequestId, actor);
  assertAuditMetadata(resetPasswordAfter, resetPasswordRequestId, actor);
  const resetPasswordBeforeData = asRecord(resetPasswordBefore.data, 'resetPassword.beforeData.data');
  const resetPasswordAfterData = asRecord(resetPasswordAfter.data, 'resetPassword.afterData.data');
  const resetPasswordBeforeUserData = asRecord(resetPasswordBeforeData.user, 'resetPassword.beforeData.data.user');
  const resetPasswordAfterUserData = asRecord(resetPasswordAfterData.user, 'resetPassword.afterData.data.user');
  assert.equal(resetPasswordBeforeUserData.id, createdUser.id);
  assert.equal(resetPasswordAfterUserData.id, createdUser.id);
  assert.equal(resetPasswordBeforeUserData.email, managedUserEmail);
  assert.equal(resetPasswordAfterUserData.email, managedUserEmail);
  assert.equal(resetPasswordBeforeData.activeSessions, 0);
  assert.equal(resetPasswordAfterData.revokedSessions, 0);
  assert.equal('passwordHash' in resetPasswordBeforeUserData, false);
  assert.equal('passwordHash' in resetPasswordAfterUserData, false);

  const createMembershipRequestId = `admin-audit-membership-create-${RUN_ID}`;
  const createMembershipResponse = await requestAdmin(cookieHeader, 'POST', '/api/admin/memberships', createMembershipRequestId, {
    userId: createdUser.id,
    companyId: createdCompany.id,
    role: Role.AUDITOR,
    isDefault: false,
  });
  if (createMembershipResponse.status !== 201) {
    const payload = await createMembershipResponse.text();
    assert.fail(`POST /api/admin/memberships a eșuat (${createMembershipResponse.status}): ${payload}`);
  }

  const createdMembership = (await createMembershipResponse.json()) as {
    id: string;
    role: Role;
  };

  const membershipCreateAudit = await loadAuditByActionAndRecord(
    'ADMIN_MEMBERSHIP_CREATE',
    createdMembership.id,
    adminUserId,
  );
  assert.equal(membershipCreateAudit.tableName, 'UserCompanyMembership');
  const membershipCreateBefore = parseAuditSnapshot(membershipCreateAudit.beforeData, 'membershipCreate.beforeData');
  const membershipCreateAfter = parseAuditSnapshot(membershipCreateAudit.afterData, 'membershipCreate.afterData');
  assertAuditMetadata(membershipCreateBefore, createMembershipRequestId, actor);
  assertAuditMetadata(membershipCreateAfter, createMembershipRequestId, actor);
  assert.deepEqual(membershipCreateBefore.data, { exists: false });
  const membershipCreateAfterData = asRecord(membershipCreateAfter.data, 'membershipCreate.afterData.data');
  assert.equal(membershipCreateAfterData.id, createdMembership.id);
  assert.equal(membershipCreateAfterData.role, createdMembership.role);

  const updateMembershipRequestId = `admin-audit-membership-update-${RUN_ID}`;
  const updateMembershipResponse = await requestAdmin(
    cookieHeader,
    'PATCH',
    `/api/admin/memberships/${createdMembership.id}`,
    updateMembershipRequestId,
    {
      role: Role.CASHIER,
    },
  );
  if (updateMembershipResponse.status !== 200) {
    const payload = await updateMembershipResponse.text();
    assert.fail(`PATCH /api/admin/memberships/:id a eșuat (${updateMembershipResponse.status}): ${payload}`);
  }

  const membershipUpdateAudit = await loadAuditByActionAndRecord(
    'ADMIN_MEMBERSHIP_UPDATE',
    createdMembership.id,
    adminUserId,
  );
  assert.equal(membershipUpdateAudit.tableName, 'UserCompanyMembership');
  const membershipUpdateBefore = parseAuditSnapshot(membershipUpdateAudit.beforeData, 'membershipUpdate.beforeData');
  const membershipUpdateAfter = parseAuditSnapshot(membershipUpdateAudit.afterData, 'membershipUpdate.afterData');
  assertAuditMetadata(membershipUpdateBefore, updateMembershipRequestId, actor);
  assertAuditMetadata(membershipUpdateAfter, updateMembershipRequestId, actor);
  const membershipUpdateBeforeData = asRecord(membershipUpdateBefore.data, 'membershipUpdate.beforeData.data');
  const membershipUpdateAfterData = asRecord(membershipUpdateAfter.data, 'membershipUpdate.afterData.data');
  assert.equal(membershipUpdateBeforeData.role, Role.AUDITOR);
  assert.equal(membershipUpdateAfterData.role, Role.CASHIER);

  const deleteMembershipRequestId = `admin-audit-membership-delete-${RUN_ID}`;
  const deleteMembershipResponse = await requestAdmin(
    cookieHeader,
    'DELETE',
    `/api/admin/memberships/${createdMembership.id}`,
    deleteMembershipRequestId,
  );
  if (deleteMembershipResponse.status !== 204) {
    const payload = await deleteMembershipResponse.text();
    assert.fail(`DELETE /api/admin/memberships/:id a eșuat (${deleteMembershipResponse.status}): ${payload}`);
  }

  const membershipDeleteAudit = await loadAuditByActionAndRecord(
    'ADMIN_MEMBERSHIP_DELETE',
    createdMembership.id,
    adminUserId,
  );
  assert.equal(membershipDeleteAudit.tableName, 'UserCompanyMembership');
  const membershipDeleteBefore = parseAuditSnapshot(membershipDeleteAudit.beforeData, 'membershipDelete.beforeData');
  const membershipDeleteAfter = parseAuditSnapshot(membershipDeleteAudit.afterData, 'membershipDelete.afterData');
  assertAuditMetadata(membershipDeleteBefore, deleteMembershipRequestId, actor);
  assertAuditMetadata(membershipDeleteAfter, deleteMembershipRequestId, actor);
  const membershipDeleteBeforeData = asRecord(membershipDeleteBefore.data, 'membershipDelete.beforeData.data');
  assert.equal(membershipDeleteBeforeData.id, createdMembership.id);
  assert.deepEqual(membershipDeleteAfter.data, { exists: false });

  const deleteUserRequestId = `admin-audit-user-delete-${RUN_ID}`;
  const deleteUserResponse = await requestAdmin(
    cookieHeader,
    'DELETE',
    `/api/admin/users/${createdUser.id}`,
    deleteUserRequestId,
  );
  if (deleteUserResponse.status !== 204) {
    const payload = await deleteUserResponse.text();
    assert.fail(`DELETE /api/admin/users/:id a eșuat (${deleteUserResponse.status}): ${payload}`);
  }

  const userDeleteAudit = await loadAuditByActionAndRecord('ADMIN_USER_DELETE', createdUser.id, adminUserId);
  assert.equal(userDeleteAudit.tableName, 'User');
  const userDeleteBefore = parseAuditSnapshot(userDeleteAudit.beforeData, 'userDelete.beforeData');
  const userDeleteAfter = parseAuditSnapshot(userDeleteAudit.afterData, 'userDelete.afterData');
  assertAuditMetadata(userDeleteBefore, deleteUserRequestId, actor);
  assertAuditMetadata(userDeleteAfter, deleteUserRequestId, actor);
  const userDeleteBeforeData = asRecord(userDeleteBefore.data, 'userDelete.beforeData.data');
  assert.equal(userDeleteBeforeData.id, createdUser.id);
  assert.equal(userDeleteBeforeData.email, managedUserEmail);
  assert.deepEqual(userDeleteAfter.data, { exists: false });

  const deleteCompanyRequestId = `admin-audit-company-delete-${RUN_ID}`;
  const deleteCompanyResponse = await requestAdmin(
    cookieHeader,
    'DELETE',
    `/api/admin/companies/${createdCompany.id}`,
    deleteCompanyRequestId,
  );
  if (deleteCompanyResponse.status !== 204) {
    const payload = await deleteCompanyResponse.text();
    assert.fail(`DELETE /api/admin/companies/:id a eșuat (${deleteCompanyResponse.status}): ${payload}`);
  }

  const companyDeleteAudit = await loadAuditByActionAndRecord('ADMIN_COMPANY_DELETE', createdCompany.id, adminUserId);
  assert.equal(companyDeleteAudit.tableName, 'Company');
  const companyDeleteBefore = parseAuditSnapshot(companyDeleteAudit.beforeData, 'companyDelete.beforeData');
  const companyDeleteAfter = parseAuditSnapshot(companyDeleteAudit.afterData, 'companyDelete.afterData');
  assertAuditMetadata(companyDeleteBefore, deleteCompanyRequestId, actor);
  assertAuditMetadata(companyDeleteAfter, deleteCompanyRequestId, actor);
  const companyDeleteBeforeData = asRecord(companyDeleteBefore.data, 'companyDelete.beforeData.data');
  assert.equal(companyDeleteBeforeData.id, createdCompany.id);
  assert.equal(companyDeleteBeforeData.name, updatedCompanyName);
  assert.deepEqual(companyDeleteAfter.data, { exists: false });
});
