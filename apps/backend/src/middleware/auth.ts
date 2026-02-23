import type { Role } from '@prisma/client';
import { generateKeyPairSync } from 'node:crypto';
import type { CookieOptions } from 'express';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { isSessionIdBlacklisted } from '../lib/auth-token-blacklist.js';
import { isMfaRequiredRole } from '../lib/mfa.js';
import type { Permission } from '../lib/rbac.js';

interface TokenUser {
  id: string;
  email: string;
  role: Role;
  name: string;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  companySelectionRequired?: boolean;
}

interface AccessTokenClaims extends TokenUser {
  typ: 'access';
  sid: string;
}

interface RefreshTokenClaims {
  typ: 'refresh';
  sub: string;
  sid: string;
  companySelectionRequired?: boolean;
}

export interface AccessTokenPayload extends AccessTokenClaims {
  exp: number;
  iat?: number;
}

export interface RefreshTokenPayload extends RefreshTokenClaims {
  exp: number;
  iat?: number;
}

export const ACCESS_COOKIE_NAME = 'sega_access_token';
export const REFRESH_COOKIE_NAME = 'sega_refresh_token';

const ACCESS_TOKEN_TTL_MS = env.JWT_ACCESS_TTL_MINUTES * 60 * 1000;
const REFRESH_TOKEN_TTL_HOURS = (() => {
  const configured = (env as Record<string, unknown>).JWT_REFRESH_TTL_HOURS;
  const legacyRefreshTtlDays = typeof env.JWT_REFRESH_TTL_DAYS === 'number' ? env.JWT_REFRESH_TTL_DAYS : 7;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  if (typeof configured === 'string') {
    const parsed = Number(configured);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return legacyRefreshTtlDays * 24;
})();
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_HOURS * 60 * 60 * 1000;

interface RsaKeyPair {
  privateKey: string;
  publicKey: string;
}

function normalizePem(value: string): string {
  return value.trim().replace(/\\n/g, '\n');
}

function generateEphemeralRsaKeyPair(label: 'access' | 'refresh'): RsaKeyPair {
  const generated = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  if (env.NODE_ENV !== 'test') {
    console.warn(`[auth] RSA ${label} key pair not provided. Using ephemeral in-memory keys.`);
  }

  return {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
  };
}

function resolveRsaKeyPair(
  label: 'access' | 'refresh',
  privateKeyInput: string | undefined,
  publicKeyInput: string | undefined,
): RsaKeyPair {
  if (privateKeyInput && publicKeyInput) {
    return {
      privateKey: normalizePem(privateKeyInput),
      publicKey: normalizePem(publicKeyInput),
    };
  }

  return generateEphemeralRsaKeyPair(label);
}

const ACCESS_RSA_KEYS = resolveRsaKeyPair('access', env.JWT_ACCESS_PRIVATE_KEY, env.JWT_ACCESS_PUBLIC_KEY);
const REFRESH_RSA_KEYS = resolveRsaKeyPair('refresh', env.JWT_REFRESH_PRIVATE_KEY, env.JWT_REFRESH_PUBLIC_KEY);

function parseCookies(req: Request): Record<string, string> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return {};
  }

  const pairs = cookieHeader.split(';');
  const parsed: Record<string, string> = {};

  for (const pair of pairs) {
    const [rawName, ...rawValueParts] = pair.split('=');
    const name = rawName?.trim();
    if (!name) {
      continue;
    }

    const rawValue = rawValueParts.join('=').trim();
    if (!rawValue) {
      continue;
    }

    try {
      parsed[name] = decodeURIComponent(rawValue);
    } catch {
      parsed[name] = rawValue;
    }
  }

  return parsed;
}

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

function getCookieToken(req: Request, cookieName: string): string | null {
  const cookies = parseCookies(req);
  const value = cookies[cookieName];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function getAccessToken(req: Request): string | null {
  return getCookieToken(req, ACCESS_COOKIE_NAME) ?? getBearerToken(req);
}

export function getRefreshToken(req: Request): string | null {
  return getCookieToken(req, REFRESH_COOKIE_NAME);
}

export function signAccessToken(payload: TokenUser & { sid: string }): string {
  return jwt.sign(
    {
      ...payload,
      typ: 'access',
    } satisfies AccessTokenClaims,
    ACCESS_RSA_KEYS.privateKey,
    {
      algorithm: 'RS256',
      expiresIn: `${env.JWT_ACCESS_TTL_MINUTES}m`,
    },
  );
}

export function signRefreshToken(payload: { userId: string; sid: string; companySelectionRequired?: boolean }): string {
  return jwt.sign(
    {
      typ: 'refresh',
      sub: payload.userId,
      sid: payload.sid,
      companySelectionRequired: payload.companySelectionRequired === true,
    } satisfies RefreshTokenClaims,
    REFRESH_RSA_KEYS.privateKey,
    {
      algorithm: 'RS256',
      expiresIn: `${REFRESH_TOKEN_TTL_HOURS}h`,
    },
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, ACCESS_RSA_KEYS.publicKey, {
    algorithms: ['RS256'],
  }) as Partial<AccessTokenPayload>;
  if (payload.typ !== 'access' || !payload.id || !payload.sid || typeof payload.exp !== 'number') {
    throw new Error('Invalid access token payload');
  }
  return payload as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, REFRESH_RSA_KEYS.publicKey, {
    algorithms: ['RS256'],
  }) as Partial<RefreshTokenPayload>;
  if (payload.typ !== 'refresh' || !payload.sub || !payload.sid || typeof payload.exp !== 'number') {
    throw new Error('Invalid refresh token payload');
  }
  return {
    ...(payload as RefreshTokenPayload),
    companySelectionRequired: payload.companySelectionRequired === true,
  };
}

export function getAccessCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api',
    maxAge: ACCESS_TOKEN_TTL_MS,
  };
}

export function getRefreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_TTL_MS,
  };
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, {
    ...getAccessCookieOptions(),
    maxAge: undefined,
  });
  res.clearCookie(REFRESH_COOKIE_NAME, {
    ...getRefreshCookieOptions(),
    maxAge: undefined,
  });
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = getAccessToken(req);
  if (!token) {
    res.status(401).json({ message: 'Token lipsă.' });
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    if (await isSessionIdBlacklisted(payload.sid)) {
      res.status(401).json({
        message: 'Token invalid sau revocat.',
        code: 'TOKEN_REVOKED',
      });
      return;
    }

    req.user = {
      id: String(payload.id),
      email: String(payload.email),
      role: payload.role as Role,
      sessionId: String(payload.sid),
      name: String(payload.name),
      mustChangePassword: payload.mustChangePassword !== false,
      mfaEnabled: payload.mfaEnabled === true,
      companySelectionRequired: payload.companySelectionRequired === true,
    };
    next();
  } catch {
    res.status(401).json({ message: 'Token invalid sau expirat.' });
  }
}

export function enforcePasswordChange(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ message: 'Neautentificat.' });
    return;
  }

  if (req.user.mustChangePassword) {
    res.status(403).json({
      message: 'Trebuie să îți schimbi parola inițială înainte de a continua.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
    return;
  }

  next();
}

export function enforceMfaEnrollment(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ message: 'Neautentificat.' });
    return;
  }

  const activeRole = req.user.companyRole ?? req.user.role;
  if (isMfaRequiredRole(activeRole) && !req.user.mfaEnabled) {
    res.status(403).json({
      message: 'Configurarea MFA (TOTP) este obligatorie pentru rolul curent.',
      code: 'MFA_SETUP_REQUIRED',
    });
    return;
  }

  next();
}

export function enforceCompanySelection(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ message: 'Neautentificat.' });
    return;
  }

  if (req.user.companySelectionRequired) {
    res.status(403).json({
      message: 'Selectează explicit compania activă înainte de a continua.',
      code: 'COMPANY_SELECTION_REQUIRED',
    });
    return;
  }

  next();
}

export function requireRoles(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: 'Neautentificat.' });
      return;
    }

    const currentRole = req.user.companyRole ?? req.user.role;
    if (!roles.includes(currentRole)) {
      res.status(403).json({ message: 'Nu ai permisiuni pentru această operațiune.' });
      return;
    }

    next();
  };
}

export function requirePermissions(...requiredPermissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: 'Neautentificat.' });
      return;
    }

    const grantedPermissions = new Set(req.user.permissions ?? []);
    const missingPermissions = requiredPermissions.filter((permission) => !grantedPermissions.has(permission));

    if (missingPermissions.length > 0) {
      res.status(403).json({
        message: 'Nu ai permisiuni pentru această operațiune.',
        missingPermissions,
      });
      return;
    }

    next();
  };
}
