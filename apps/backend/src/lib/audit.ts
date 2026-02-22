import type { Prisma, Role } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from './prisma.js';

export interface AuditPayload {
  tableName: string;
  recordId?: string;
  action: string;
  reason?: string;
  companyId?: string;
  userEmail?: string;
  userRole?: Role;
  sessionId?: string;
  oldValues?: unknown;
  newValues?: unknown;
  beforeData?: unknown;
  afterData?: unknown;
  userId?: string;
}

type AuditDbClient = Pick<Prisma.TransactionClient, 'auditLog'>;
type ColumnRow = { column_name: string };

const EXTENDED_AUDIT_COLUMNS = ['userEmail', 'userRole', 'sessionId', 'oldValues', 'newValues'] as const;
let supportsExtendedAuditColumnsCache: boolean | null = null;

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isMissingColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('does not exist') && error.message.includes('column');
}

function isTransactionAbortedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('current transaction is aborted');
}

async function supportsExtendedAuditColumns(): Promise<boolean> {
  if (supportsExtendedAuditColumnsCache !== null) {
    return supportsExtendedAuditColumnsCache;
  }

  try {
    const rows = await prisma.$queryRaw<ColumnRow[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'AuditLog'
    `;

    const availableColumns = new Set(rows.map((row) => row.column_name));
    supportsExtendedAuditColumnsCache = EXTENDED_AUDIT_COLUMNS.every((columnName) => availableColumns.has(columnName));
  } catch {
    // Prefer the extended payload when schema detection is unavailable.
    supportsExtendedAuditColumnsCache = true;
  }

  return supportsExtendedAuditColumnsCache;
}

export async function writeAudit(req: Request, payload: AuditPayload, db: AuditDbClient = prisma): Promise<void> {
  const resolvedOldValues = payload.oldValues ?? payload.beforeData;
  const resolvedNewValues = payload.newValues ?? payload.afterData;
  const resolvedRole = payload.userRole ?? req.user?.companyRole ?? req.user?.role;
  const oldValuesJson = toJson(resolvedOldValues);
  const newValuesJson = toJson(resolvedNewValues);
  const commonData = {
    userId: payload.userId ?? req.user?.id,
    companyId: payload.companyId ?? req.user?.companyId,
    tableName: payload.tableName,
    recordId: payload.recordId,
    action: payload.action,
    reason: payload.reason,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  };
  const extendedData = {
    ...commonData,
    userEmail: payload.userEmail ?? req.user?.email,
    userRole: resolvedRole,
    sessionId: payload.sessionId ?? req.user?.sessionId,
    oldValues: oldValuesJson,
    newValues: newValuesJson,
    beforeData: oldValuesJson,
    afterData: newValuesJson,
  };
  const legacyData = {
    ...commonData,
    beforeData: oldValuesJson,
    afterData: newValuesJson,
  };
  const canWriteExtended = await supportsExtendedAuditColumns();

  if (canWriteExtended) {
    try {
      await db.auditLog.create({ data: extendedData });
      return;
    } catch (error) {
      if (!isMissingColumnError(error)) {
        throw error;
      }

      supportsExtendedAuditColumnsCache = false;
      try {
        await db.auditLog.create({ data: legacyData });
        return;
      } catch (fallbackError) {
        if (isTransactionAbortedError(fallbackError)) {
          throw error;
        }

        throw fallbackError;
      }
    }
  }

  await db.auditLog.create({ data: legacyData });
}
