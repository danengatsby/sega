import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { User } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { blacklistSessionId, isSessionIdBlacklisted } from './auth-token-blacklist.js';
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  clearAuthCookies,
  getAccessCookieOptions,
  getRefreshCookieOptions,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../middleware/auth.js';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: User['role'];
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  companySelectionRequired?: boolean;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

const REFRESH_TOKEN_TTL_MS = env.JWT_REFRESH_TTL_HOURS * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toPublicUser(user: User, companySelectionRequired: boolean): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    companySelectionRequired,
  };
}

function buildTokens(user: User, sessionId: string, companySelectionRequired: boolean): AuthTokens {
  const accessToken = signAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    companySelectionRequired,
    sid: sessionId,
  });

  const refreshToken = signRefreshToken({
    userId: user.id,
    sid: sessionId,
    companySelectionRequired,
  });

  return {
    accessToken,
    refreshToken,
    sessionId,
  };
}

async function createRefreshSession(
  user: User,
  sessionId: string,
  refreshToken: string,
  req: Request,
): Promise<void> {
  await prisma.refreshSession.create({
    data: {
      id: sessionId,
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userAgent: req.headers['user-agent']?.slice(0, 512) ?? null,
      ipAddress: req.ip || null,
    },
  });
}

export async function issueLoginSession(
  user: User,
  req: Request,
  res: Response,
  options?: { companySelectionRequired?: boolean },
): Promise<PublicUser> {
  const companySelectionRequired = options?.companySelectionRequired === true;
  const sessionId = randomUUID();
  const tokens = buildTokens(user, sessionId, companySelectionRequired);
  await createRefreshSession(user, sessionId, tokens.refreshToken, req);

  res.cookie(ACCESS_COOKIE_NAME, tokens.accessToken, getAccessCookieOptions());
  res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, getRefreshCookieOptions());

  return toPublicUser(user, companySelectionRequired);
}

export async function rotateRefreshSession(req: Request, res: Response, refreshToken: string): Promise<PublicUser | null> {
  let payload: { sid: string; sub: string; companySelectionRequired?: boolean };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    clearAuthCookies(res);
    return null;
  }

  if (await isSessionIdBlacklisted(payload.sid)) {
    clearAuthCookies(res);
    return null;
  }

  const existingSession = await prisma.refreshSession.findUnique({
    where: { id: payload.sid },
    include: { user: true },
  });

  if (!existingSession || existingSession.userId !== payload.sub) {
    clearAuthCookies(res);
    return null;
  }

  if (existingSession.revokedAt || existingSession.expiresAt.getTime() <= Date.now()) {
    clearAuthCookies(res);
    return null;
  }

  const expectedHash = existingSession.tokenHash;
  const providedHash = hashToken(refreshToken);
  if (expectedHash !== providedHash) {
    await prisma.refreshSession.updateMany({
      where: {
        userId: existingSession.userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    clearAuthCookies(res);
    return null;
  }

  const nextSessionId = randomUUID();
  const companySelectionRequired = payload.companySelectionRequired === true;
  const tokens = buildTokens(existingSession.user, nextSessionId, companySelectionRequired);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.refreshSession.update({
      where: { id: existingSession.id },
      data: {
        revokedAt: now,
        replacedBySessionId: nextSessionId,
      },
    });

    await tx.refreshSession.create({
      data: {
        id: nextSessionId,
        userId: existingSession.userId,
        tokenHash: hashToken(tokens.refreshToken),
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
        userAgent: req.headers['user-agent']?.slice(0, 512) ?? null,
        ipAddress: req.ip || null,
      },
    });
  });

  res.cookie(ACCESS_COOKIE_NAME, tokens.accessToken, getAccessCookieOptions());
  res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, getRefreshCookieOptions());

  return toPublicUser(existingSession.user, companySelectionRequired);
}

export async function revokeRefreshSessionByToken(refreshToken: string): Promise<void> {
  try {
    const payload = verifyRefreshToken(refreshToken);
    await prisma.refreshSession.updateMany({
      where: {
        id: payload.sid,
        userId: payload.sub,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    await blacklistSessionId(payload.sid, payload.exp);
  } catch {
    // Ignore invalid tokens on logout attempts.
  }
}

export async function revokeSessionByAccessToken(accessToken: string): Promise<void> {
  try {
    const payload = verifyAccessToken(accessToken);
    await prisma.refreshSession.updateMany({
      where: {
        id: payload.sid,
        userId: payload.id,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    await blacklistSessionId(payload.sid, payload.exp);
  } catch {
    // Ignore invalid tokens on logout attempts.
  }
}
