import { OpenBankingConnectionStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { HttpError } from '../lib/http-error.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions } from '../middleware/auth.js';
import {
  OPEN_BANKING_BANK_CODES,
  parseOpenBankingBankCode,
  providerNameForBankCode,
} from '../services/open-banking/banks.js';
import { exchangeOpenBankingAccessToken } from '../services/open-banking/pilot-bcr-connector.js';
import { runOpenBankingSync } from '../services/open-banking/sync-service.js';

const router = Router();

const createConnectionSchema = z.object({
  bankCode: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
    z.enum(OPEN_BANKING_BANK_CODES).default('BCR'),
  ),
  providerName: z.string().trim().min(2).max(120).optional(),
  accountCode: z.string().trim().min(1).default('5121'),
  externalConsentId: z.string().trim().min(3).optional(),
  externalAccountId: z.string().trim().min(3).optional(),
  reason: z.string().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'DISABLED']),
  reason: z.string().optional(),
});

const oauthTokenSchema = z.object({
  authorizationCode: z.string().trim().min(6).optional(),
  refreshToken: z.string().trim().min(10).optional(),
  redirectUri: z.string().url().optional(),
  reason: z.string().optional(),
});

const syncSchema = z.object({
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  reason: z.string().optional(),
});

function resolveConnectionBankCode(rawBankCode: string) {
  const bankCode = parseOpenBankingBankCode(rawBankCode);
  if (!bankCode) {
    throw HttpError.badRequest(`Cod bancă Open Banking neacceptat: ${rawBankCode}`);
  }
  return bankCode;
}

async function readConnectionOrThrow(connectionId: string, companyId: string) {
  const connection = await prisma.openBankingConnection.findFirst({
    where: {
      id: connectionId,
      companyId,
    },
  });

  if (!connection) {
    throw HttpError.notFound('Conexiunea Open Banking nu există.');
  }

  return connection;
}

router.get('/connections', requirePermissions(PERMISSIONS.OPEN_BANKING_READ), async (req, res) => {
  const includeDisabled = req.query.includeDisabled === 'true';
  const connections = await prisma.openBankingConnection.findMany({
    where: {
      companyId: req.user!.companyId!,
      ...(includeDisabled ? {} : { status: { not: OpenBankingConnectionStatus.DISABLED } }),
    },
    orderBy: [{ createdAt: 'desc' }],
    select: {
      id: true,
      bankCode: true,
      providerName: true,
      accountCode: true,
      externalConsentId: true,
      externalAccountId: true,
      status: true,
      tokenExpiresAt: true,
      lastSyncedAt: true,
      lastCursorDate: true,
      errorCount: true,
      lastErrorAt: true,
      lastErrorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  res.json(connections);
});

router.post('/connections', requirePermissions(PERMISSIONS.OPEN_BANKING_WRITE), async (req, res) => {
  const parsed = createConnectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru conexiunea Open Banking.' });
    return;
  }

  const companyId = req.user!.companyId!;
  const account = await prisma.account.findFirst({
    where: {
      companyId,
      code: parsed.data.accountCode,
      isActive: true,
    },
    select: { id: true },
  });
  if (!account) {
    throw HttpError.badRequest('Contul contabil pentru reconciliere nu există sau este inactiv.');
  }

  const connection = await prisma.openBankingConnection.create({
    data: {
      companyId,
      createdById: req.user!.id,
      bankCode: parsed.data.bankCode,
      providerName: parsed.data.providerName ?? providerNameForBankCode(parsed.data.bankCode),
      accountCode: parsed.data.accountCode,
      externalConsentId: parsed.data.externalConsentId,
      externalAccountId: parsed.data.externalAccountId,
      status: OpenBankingConnectionStatus.PENDING,
    },
  });

  await writeAudit(req, {
    tableName: 'open_banking_connections',
    recordId: connection.id,
    action: 'CREATE',
    reason: parsed.data.reason,
    afterData: {
      bankCode: connection.bankCode,
      providerName: connection.providerName,
      accountCode: connection.accountCode,
      status: connection.status,
    },
  });

  res.status(201).json(connection);
});

router.patch('/connections/:id/status', requirePermissions(PERMISSIONS.OPEN_BANKING_WRITE), async (req, res) => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Status invalid pentru conexiunea Open Banking.' });
    return;
  }

  const connection = await readConnectionOrThrow(String(req.params.id), req.user!.companyId!);

  if (parsed.data.status === 'ACTIVE' && !connection.accessToken) {
    throw HttpError.conflict('Conexiunea nu poate fi activată fără token OAuth2 valid.');
  }

  const updated = await prisma.openBankingConnection.update({
    where: { id: connection.id },
    data: {
      status: parsed.data.status,
    },
  });

  await writeAudit(req, {
    tableName: 'open_banking_connections',
    recordId: updated.id,
    action: 'STATUS_UPDATE',
    reason: parsed.data.reason,
    beforeData: {
      status: connection.status,
    },
    afterData: {
      status: updated.status,
    },
  });

  res.json(updated);
});

router.post('/connections/:id/oauth2/token', requirePermissions(PERMISSIONS.OPEN_BANKING_WRITE), async (req, res) => {
  const parsed = oauthTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru token exchange OAuth2.' });
    return;
  }

  const connection = await readConnectionOrThrow(String(req.params.id), req.user!.companyId!);
  const grantType = parsed.data.authorizationCode ? 'authorization_code' : 'refresh_token';
  const refreshToken = parsed.data.refreshToken ?? connection.refreshToken ?? undefined;

  if (grantType === 'refresh_token' && !refreshToken) {
    throw HttpError.badRequest('authorizationCode sau refreshToken sunt obligatorii pentru token exchange.');
  }

  const token = await exchangeOpenBankingAccessToken({
    bankCode: resolveConnectionBankCode(connection.bankCode),
    grantType,
    code: parsed.data.authorizationCode,
    redirectUri: parsed.data.redirectUri,
    refreshToken,
  });

  const updated = await prisma.openBankingConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? refreshToken,
      tokenExpiresAt: token.expiresAt,
      status: OpenBankingConnectionStatus.ACTIVE,
      lastErrorAt: null,
      lastErrorMessage: null,
    },
  });

  await writeAudit(req, {
    tableName: 'open_banking_connections',
    recordId: updated.id,
    action: 'OAUTH_TOKEN_EXCHANGE',
    reason: parsed.data.reason,
    afterData: {
      status: updated.status,
      tokenExpiresAt: updated.tokenExpiresAt,
    },
  });

  res.json({
    id: updated.id,
    status: updated.status,
    tokenExpiresAt: updated.tokenExpiresAt,
  });
});

router.post('/connections/:id/sync', requirePermissions(PERMISSIONS.OPEN_BANKING_WRITE), async (req, res) => {
  const parsed = syncSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru sincronizarea Open Banking.' });
    return;
  }

  const connection = await readConnectionOrThrow(String(req.params.id), req.user!.companyId!);
  const summary = await runOpenBankingSync({
    connectionId: connection.id,
    companyId: connection.companyId,
    initiatedByUserId: req.user!.id,
    fromDate: parsed.data.fromDate ? new Date(parsed.data.fromDate) : undefined,
    toDate: parsed.data.toDate ? new Date(parsed.data.toDate) : undefined,
    source: 'manual',
  });

  await writeAudit(req, {
    tableName: 'open_banking_sync_runs',
    recordId: summary.syncRunId,
    action: 'SYNC_TRIGGER',
    reason: parsed.data.reason,
    afterData: {
      connectionId: summary.connectionId,
      statementsImported: summary.statementsImported,
      transactionsImported: summary.transactionsImported,
      balancesSynced: summary.balancesSynced,
      cursorFrom: summary.cursorFrom,
      cursorTo: summary.cursorTo,
    },
  });

  res.status(201).json(summary);
});

router.get('/connections/:id/sync-runs', requirePermissions(PERMISSIONS.OPEN_BANKING_READ), async (req, res) => {
  const connection = await readConnectionOrThrow(String(req.params.id), req.user!.companyId!);
  const takeRaw = Number(req.query.take ?? 20);
  const take = Number.isInteger(takeRaw) ? Math.min(Math.max(takeRaw, 1), 100) : 20;

  const runs = await prisma.openBankingSyncRun.findMany({
    where: {
      connectionId: connection.id,
      companyId: connection.companyId,
    },
    orderBy: [{ startedAt: 'desc' }],
    take,
    select: {
      id: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      cursorFrom: true,
      cursorTo: true,
      statementsImported: true,
      transactionsImported: true,
      balancesSynced: true,
      errorMessage: true,
      initiatedByUserId: true,
    },
  });

  res.json(runs);
});

export default router;
