import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/http-error.js';
import { runWithRequestTransaction } from '../lib/db-request-context.js';
import { prisma } from '../lib/prisma.js';

function requestUserAgent(req: Request): string | null {
  const header = req.headers['user-agent'];
  if (Array.isArray(header)) {
    return header[0]?.slice(0, 512) ?? null;
  }

  return typeof header === 'string' ? header.slice(0, 512) : null;
}

function requestAuditReason(req: Request): string | null {
  const header = req.headers['x-audit-reason'];
  if (Array.isArray(header)) {
    const value = header[0]?.trim();
    return value ? value.slice(0, 512) : null;
  }

  if (typeof header !== 'string') {
    return null;
  }

  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 512) : null;
}

function waitForResponseClose(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const finalize = () => {
      res.off('finish', finalize);
      res.off('close', finalize);
      resolve();
    };

    res.once('finish', finalize);
    res.once('close', finalize);
  });
}

let setRequestContextAvailable: boolean | null = null;

async function hasSetRequestContextFunction(): Promise<boolean> {
  if (setRequestContextAvailable !== null) {
    return setRequestContextAvailable;
  }

  const rows = await prisma.$queryRaw<Array<{ available: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n
        ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_private'
        AND p.proname = 'set_request_context'
    ) AS available
  `;
  setRequestContextAvailable = rows[0]?.available === true;
  return setRequestContextAvailable;
}

async function setDbRequestContext(req: Request, companyId: string, userId: string): Promise<void> {
  const userRole = req.user?.companyRole ?? req.user?.role ?? null;
  const userSessionId = req.user?.sessionId ?? null;
  const ipAddress = req.ip || null;
  const userAgent = requestUserAgent(req);
  const reason = requestAuditReason(req);

  if (await hasSetRequestContextFunction()) {
    await prisma.$executeRaw`
      SELECT app_private.set_request_context(
        ${companyId}::uuid,
        ${userId}::uuid,
        ${req.user?.email ?? null},
        ${userRole},
        ${userSessionId}::uuid,
        ${ipAddress},
        ${userAgent},
        ${reason}
      )
    `;
    return;
  }

  await prisma.$executeRaw`
    SELECT
      set_config('app.company_id', ${companyId}, true),
      set_config('app.user_id', ${userId}, true),
      set_config('app.user_email', ${req.user?.email ?? ''}, true),
      set_config('app.user_role', ${userRole ?? ''}, true),
      set_config('app.session_id', ${userSessionId ?? ''}, true),
      set_config('app.ip_address', ${ipAddress ?? ''}, true),
      set_config('app.user_agent', ${userAgent ?? ''}, true),
      set_config('app.audit_reason', ${reason ?? ''}, true)
  `;
}

export async function bindDbRequestContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    next(HttpError.unauthorized());
    return;
  }

  const companyId = req.user.companyId?.trim();
  if (!companyId) {
    next(HttpError.forbidden('Context companie lipsă pentru request-ul curent.'));
    return;
  }

  const userId = req.user.id?.trim();
  if (!userId) {
    next(HttpError.unauthorized('Identitatea utilizatorului este invalidă.'));
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await runWithRequestTransaction(tx, async () => {
        await setDbRequestContext(req, companyId, userId);
        next();
        await waitForResponseClose(res);
      });
    });
  } catch (error) {
    next(error);
  }
}
