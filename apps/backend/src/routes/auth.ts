import { timingSafeEqual } from 'node:crypto';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { PublicUser } from '../lib/auth-session.js';
import { issueLoginSession, revokeRefreshSessionByToken, rotateRefreshSession } from '../lib/auth-session.js';
import { readRequestedCompanyId, resolveUserCompanyAccessContext } from '../lib/company-access.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/http-error.js';
import type { Permission } from '../lib/rbac.js';
import { buildMfaSetupPayload, generateTotpSecret, isMfaRequiredRole, verifyTotpCode } from '../lib/mfa.js';
import { writeAudit } from '../lib/audit.js';
import { authenticate, clearAuthCookies, getRefreshToken } from '../middleware/auth.js';

const router = Router();
let bootstrapTokenConsumed = false;
const DEFAULT_BOOTSTRAP_COMPANY_CODE = 'default';
const DEFAULT_BOOTSTRAP_COMPANY_NAME = 'Compania implicită';
const companyCodePattern = /^[A-Za-z0-9._-]+$/;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfaCode: z.string().min(6).max(12).optional(),
});

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(160),
  password: z.string().min(12).max(128),
});

const bootstrapSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(12),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});

const switchCompanySchema = z.object({
  companyId: z.string().min(1),
  makeDefault: z.boolean().default(true),
  reason: z.string().optional(),
});

const mfaVerifySchema = z.object({
  code: z.string().min(6).max(12),
});

const companyCreateSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(32)
    .regex(companyCodePattern, 'Codul companiei poate conține doar litere, cifre, punct, underscore și minus.'),
  name: z.string().min(2).max(180),
  cui: z.string().max(64).optional().nullable(),
  registrationNumber: z.string().max(64).optional().nullable(),
  address: z.string().max(255).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  county: z.string().max(80).optional().nullable(),
  country: z.string().max(80).optional().nullable(),
  bankName: z.string().max(120).optional().nullable(),
  iban: z.string().max(64).optional().nullable(),
  email: z.string().max(160).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  reason: z.string().max(256).optional(),
});

interface AuthCompanySummary {
  id: string;
  code: string;
  name: string;
  role: Role;
  isDefault: boolean;
}

interface AuthenticatedUserPayload extends PublicUser {
  companyId: string | null;
  companyCode: string | null;
  companyName: string | null;
  companyRole: Role | null;
  permissions: Permission[];
  availableCompanies: AuthCompanySummary[];
  companyOnboardingRequired: boolean;
}

function tokensEqual(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function readBootstrapToken(headerValue: string | string[] | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  if (Array.isArray(headerValue)) {
    return headerValue[0] ?? null;
  }

  const token = headerValue.trim();
  return token.length > 0 ? token : null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCompanyCode(code: string): string {
  return code.trim().toUpperCase();
}

function isPrismaKnownError(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string' &&
      (error as { code: string }).code === code,
  );
}

async function buildUserAuthContext(
  req: Request,
  publicUser: PublicUser,
  requestedCompanyIdOverride?: string | null,
): Promise<AuthenticatedUserPayload> {
  const requestedCompanyId = requestedCompanyIdOverride ?? readRequestedCompanyId(req);
  let access = await resolveUserCompanyAccessContext(publicUser.id, requestedCompanyId);
  if (!access && requestedCompanyId) {
    access = await resolveUserCompanyAccessContext(publicUser.id, null);
  }

  if (publicUser.companySelectionRequired) {
    return {
      ...publicUser,
      companyId: null,
      companyCode: null,
      companyName: null,
      companyRole: null,
      permissions: [],
      availableCompanies: access?.availableCompanies ?? [],
      companyOnboardingRequired: true,
    };
  }

  if (!access) {
    return {
      ...publicUser,
      companyId: null,
      companyCode: null,
      companyName: null,
      companyRole: null,
      permissions: [],
      availableCompanies: [],
      companyOnboardingRequired: true,
    };
  }

  return {
    ...publicUser,
    companyId: access.companyId,
    companyCode: access.companyCode,
    companyName: access.companyName,
    companyRole: access.role,
    permissions: access.permissions,
    availableCompanies: access.availableCompanies,
    companyOnboardingRequired: false,
  };
}

async function revokeAllActiveRefreshSessions(userId: string): Promise<void> {
  await prisma.refreshSession.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide la autentificare.' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(parsed.data.email) } });
  if (!user) {
    res.status(401).json({ message: 'Email sau parolă incorectă.' });
    return;
  }

  const passwordMatches = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!passwordMatches) {
    res.status(401).json({ message: 'Email sau parolă incorectă.' });
    return;
  }

  if (isMfaRequiredRole(user.role) && user.mfaEnabled) {
    if (!user.mfaSecret) {
      res.status(409).json({
        message: 'Configurația MFA este invalidă. Reconfigurează MFA din profil.',
        code: 'MFA_CONFIGURATION_INVALID',
      });
      return;
    }

    const mfaCode = parsed.data.mfaCode?.trim();
    if (!mfaCode) {
      res.status(401).json({
        message: 'Codul MFA este obligatoriu pentru acest cont.',
        code: 'MFA_CODE_REQUIRED',
      });
      return;
    }

    if (!verifyTotpCode(mfaCode, user.mfaSecret)) {
      res.status(401).json({
        message: 'Cod MFA invalid.',
        code: 'MFA_INVALID_CODE',
      });
      return;
    }
  }

  const publicUser = await issueLoginSession(user, req, res, { companySelectionRequired: true });
  const userWithContext = await buildUserAuthContext(req, publicUser);
  res.json({ user: userWithContext });
});

router.post('/register', async (req, res, next) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru crearea contului.' });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const createdUser = await prisma.user.create({
      data: {
        email: normalizeEmail(parsed.data.email),
        name: parsed.data.name.trim(),
        passwordHash,
        role: Role.ACCOUNTANT,
        mustChangePassword: false,
        mfaEnabled: false,
        mfaSecret: null,
        mfaPendingSecret: null,
      },
    });

    await writeAudit(req, {
      tableName: 'users',
      recordId: createdUser.id,
      action: 'REGISTER',
      reason: 'self-signup',
      userId: createdUser.id,
      userEmail: createdUser.email,
      userRole: createdUser.role,
      afterData: {
        email: createdUser.email,
        name: createdUser.name,
        role: createdUser.role,
      },
    });

    const publicUser = await issueLoginSession(createdUser, req, res, { companySelectionRequired: true });
    const userWithContext = await buildUserAuthContext(req, publicUser);
    res.status(201).json({ user: userWithContext });
  } catch (error) {
    if (isPrismaKnownError(error, 'P2002')) {
      res.status(409).json({ message: 'Există deja un cont cu acest email.' });
      return;
    }
    next(error);
  }
});

router.post('/mfa/setup', authenticate, async (req, res) => {
  const secret = generateTotpSecret();
  const updatedUser = await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      mfaPendingSecret: secret,
    },
    select: {
      id: true,
      email: true,
      mfaEnabled: true,
      role: true,
    },
  });

  await writeAudit(req, {
    tableName: 'users',
    recordId: updatedUser.id,
    action: 'MFA_SETUP_INIT',
    reason: 'mfa-setup',
    afterData: {
      mfaPendingSecret: true,
      mfaEnabled: updatedUser.mfaEnabled,
    },
  });

  const payload = buildMfaSetupPayload(updatedUser.email, secret);
  res.json({
    ...payload,
    required: isMfaRequiredRole(req.user!.companyRole ?? updatedUser.role),
  });
});

router.post('/mfa/verify', authenticate, async (req, res) => {
  const parsed = mfaVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Codul MFA este invalid.' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
  });

  if (!user) {
    clearAuthCookies(res);
    res.status(404).json({ message: 'Utilizator inexistent.' });
    return;
  }

  if (!user.mfaPendingSecret) {
    res.status(409).json({
      message: 'Nu există o configurare MFA în curs de verificare.',
      code: 'MFA_SETUP_NOT_INITIALIZED',
    });
    return;
  }

  if (!verifyTotpCode(parsed.data.code, user.mfaPendingSecret)) {
    res.status(401).json({
      message: 'Cod MFA invalid.',
      code: 'MFA_INVALID_CODE',
    });
    return;
  }

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabled: true,
      mfaSecret: user.mfaPendingSecret,
      mfaPendingSecret: null,
    },
  });

  await writeAudit(req, {
    tableName: 'users',
    recordId: updatedUser.id,
    action: 'MFA_ENABLED',
    reason: 'mfa-verify',
    afterData: {
      mfaEnabled: true,
    },
  });

  await revokeAllActiveRefreshSessions(updatedUser.id);
  const publicUser = await issueLoginSession(updatedUser, req, res, {
    companySelectionRequired: req.user?.companySelectionRequired === true,
  });
  const userWithContext = await buildUserAuthContext(req, publicUser);
  res.json({ user: userWithContext });
});

router.post('/mfa/disable', authenticate, async (req, res) => {
  const activeRole = req.user!.companyRole ?? req.user!.role;
  if (isMfaRequiredRole(activeRole)) {
    res.status(403).json({
      message: 'Rolul curent necesită MFA activ. Dezactivarea nu este permisă.',
      code: 'MFA_REQUIRED_FOR_ROLE',
    });
    return;
  }

  const parsed = mfaVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Codul MFA este invalid.' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
  });

  if (!user) {
    clearAuthCookies(res);
    res.status(404).json({ message: 'Utilizator inexistent.' });
    return;
  }

  if (!user.mfaEnabled || !user.mfaSecret) {
    res.status(409).json({
      message: 'MFA nu este activ pentru acest cont.',
      code: 'MFA_NOT_ENABLED',
    });
    return;
  }

  if (!verifyTotpCode(parsed.data.code, user.mfaSecret)) {
    res.status(401).json({
      message: 'Cod MFA invalid.',
      code: 'MFA_INVALID_CODE',
    });
    return;
  }

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabled: false,
      mfaSecret: null,
      mfaPendingSecret: null,
    },
  });

  await writeAudit(req, {
    tableName: 'users',
    recordId: updatedUser.id,
    action: 'MFA_DISABLED',
    reason: 'mfa-disable',
    afterData: {
      mfaEnabled: false,
    },
  });

  await revokeAllActiveRefreshSessions(updatedUser.id);
  const publicUser = await issueLoginSession(updatedUser, req, res, {
    companySelectionRequired: req.user?.companySelectionRequired === true,
  });
  const userWithContext = await buildUserAuthContext(req, publicUser);
  res.json({ user: userWithContext });
});

router.post('/companies', authenticate, async (req, res, next) => {
  const parsed = companyCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru crearea companiei.' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
  });

  if (!user) {
    clearAuthCookies(res);
    res.status(404).json({ message: 'Utilizator inexistent.' });
    return;
  }

  try {
    const createdCompany = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          code: normalizeCompanyCode(parsed.data.code),
          name: parsed.data.name.trim(),
          cui: normalizeOptionalString(parsed.data.cui),
          registrationNumber: normalizeOptionalString(parsed.data.registrationNumber),
          address: normalizeOptionalString(parsed.data.address),
          city: normalizeOptionalString(parsed.data.city),
          county: normalizeOptionalString(parsed.data.county),
          country: normalizeOptionalString(parsed.data.country) ?? 'RO',
          bankName: normalizeOptionalString(parsed.data.bankName),
          iban: normalizeOptionalString(parsed.data.iban),
          email: normalizeOptionalString(parsed.data.email),
          phone: normalizeOptionalString(parsed.data.phone),
          isActive: true,
        },
        select: {
          id: true,
          code: true,
          name: true,
        },
      });

      await tx.userCompanyMembership.updateMany({
        where: {
          userId: user.id,
          isDefault: true,
        },
        data: {
          isDefault: false,
        },
      });

      const membership = await tx.userCompanyMembership.create({
        data: {
          userId: user.id,
          companyId: company.id,
          role: user.role,
          isDefault: true,
        },
        select: {
          id: true,
        },
      });

      await writeAudit(
        req,
        {
          tableName: 'companies',
          recordId: company.id,
          action: 'CREATE',
          reason: parsed.data.reason ?? 'self-company-create',
          companyId: company.id,
          afterData: {
            id: company.id,
            code: company.code,
            name: company.name,
          },
        },
        tx,
      );

      await writeAudit(
        req,
        {
          tableName: 'user_company_memberships',
          recordId: membership.id,
          action: 'CREATE',
          reason: parsed.data.reason ?? 'self-company-create',
          companyId: company.id,
          afterData: {
            userId: user.id,
            companyId: company.id,
            role: user.role,
            isDefault: true,
          },
        },
        tx,
      );

      return company;
    });

    const publicUser = await issueLoginSession(user, req, res, {
      companySelectionRequired: false,
    });
    const userWithContext = await buildUserAuthContext(req, publicUser, createdCompany.id);
    res.status(201).json({ user: userWithContext });
  } catch (error) {
    if (isPrismaKnownError(error, 'P2002')) {
      res.status(409).json({ message: 'Codul companiei există deja.' });
      return;
    }
    next(error);
  }
});

router.post('/switch-company', authenticate, async (req, res) => {
  const parsed = switchCompanySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru schimbarea companiei active.' });
    return;
  }

  const requestedCompanyId = parsed.data.companyId.trim();
  if (requestedCompanyId.length === 0) {
    res.status(400).json({ message: 'Compania selectată este invalidă.' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
  });

  if (!user) {
    clearAuthCookies(res);
    res.status(404).json({ message: 'Utilizator inexistent.' });
    return;
  }

  const access = await resolveUserCompanyAccessContext(user.id, requestedCompanyId);
  if (!access || access.companyId !== requestedCompanyId) {
    res.status(403).json({ message: 'Nu ai acces la compania selectată.' });
    return;
  }

  if (parsed.data.makeDefault) {
    await prisma.$transaction(async (tx) => {
      const selectedMembership = await tx.userCompanyMembership.findFirst({
        where: {
          userId: user.id,
          companyId: requestedCompanyId,
          company: {
            isActive: true,
          },
        },
        select: {
          id: true,
        },
      });

      if (!selectedMembership) {
        throw HttpError.forbidden('Nu ai acces la compania selectată.');
      }

      await tx.userCompanyMembership.updateMany({
        where: {
          userId: user.id,
          isDefault: true,
        },
        data: {
          isDefault: false,
        },
      });

      await tx.userCompanyMembership.update({
        where: {
          id: selectedMembership.id,
        },
        data: {
          isDefault: true,
        },
      });

      await writeAudit(
        req,
        {
          tableName: 'user_company_memberships',
          recordId: selectedMembership.id,
          action: 'SWITCH_COMPANY_CONTEXT',
          reason: parsed.data.reason ?? 'switch-company-default',
          companyId: requestedCompanyId,
          afterData: {
            companyId: requestedCompanyId,
            makeDefault: true,
          },
        },
        tx,
      );
    });
  } else {
    await writeAudit(req, {
      tableName: 'user_company_memberships',
      action: 'SWITCH_COMPANY_CONTEXT',
      reason: parsed.data.reason ?? 'switch-company-session-only',
      companyId: requestedCompanyId,
      afterData: {
        companyId: requestedCompanyId,
        makeDefault: false,
      },
    });
  }

  const publicUser = await issueLoginSession(user, req, res, {
    companySelectionRequired: false,
  });
  const userWithContext = await buildUserAuthContext(req, publicUser, requestedCompanyId);
  res.json({ user: userWithContext });
});

router.post('/bootstrap-admin', async (req, res) => {
  if (env.NODE_ENV === 'production') {
    res.status(403).json({ message: 'Bootstrap admin este dezactivat în producție.' });
    return;
  }

  if (!env.BOOTSTRAP_ADMIN_ENABLED) {
    res.status(403).json({ message: 'Bootstrap admin este dezactivat.' });
    return;
  }

  if (bootstrapTokenConsumed) {
    res.status(409).json({ message: 'Token-ul de bootstrap a fost deja folosit.' });
    return;
  }

  const configuredBootstrapToken = env.BOOTSTRAP_ADMIN_TOKEN;
  const providedBootstrapToken = readBootstrapToken(req.headers['x-bootstrap-token']);

  if (!configuredBootstrapToken || !providedBootstrapToken || !tokensEqual(configuredBootstrapToken, providedBootstrapToken)) {
    res.status(401).json({ message: 'Token bootstrap invalid.' });
    return;
  }

  const parsed = bootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide.' });
    return;
  }

  const user = await prisma.$transaction(async (tx) => {
    const userCount = await tx.user.count();
    if (userCount > 0) {
      throw HttpError.conflict('Bootstrap dezactivat: există deja utilizatori.');
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const createdUser = await tx.user.create({
      data: {
        email: normalizeEmail(parsed.data.email),
        name: parsed.data.name,
        passwordHash,
        role: Role.ADMIN,
        mustChangePassword: true,
      },
    });

    const fallbackCompany =
      (await tx.company.findFirst({
        where: { isActive: true },
        orderBy: [{ createdAt: 'asc' }],
      })) ??
      (await tx.company.upsert({
        where: { code: DEFAULT_BOOTSTRAP_COMPANY_CODE },
        update: {
          name: DEFAULT_BOOTSTRAP_COMPANY_NAME,
          isActive: true,
        },
        create: {
          code: DEFAULT_BOOTSTRAP_COMPANY_CODE,
          name: DEFAULT_BOOTSTRAP_COMPANY_NAME,
          isActive: true,
        },
      }));

    await tx.userCompanyMembership.create({
      data: {
        userId: createdUser.id,
        companyId: fallbackCompany.id,
        role: Role.ADMIN,
        isDefault: true,
      },
    });

    await writeAudit(
      req,
      {
        tableName: 'users',
        recordId: createdUser.id,
        action: 'CREATE',
        reason: 'bootstrap-admin',
        afterData: {
          email: createdUser.email,
          name: createdUser.name,
          role: createdUser.role,
          mustChangePassword: createdUser.mustChangePassword,
        },
        userId: createdUser.id,
      },
      tx,
    );

    return createdUser;
  });

  bootstrapTokenConsumed = true;

  res.status(201).json({
    id: user.id,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  });
});

router.post('/change-password', authenticate, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru schimbare parolă.' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    res.status(404).json({ message: 'Utilizator inexistent.' });
    return;
  }

  const currentMatches = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!currentMatches) {
    res.status(401).json({ message: 'Parola curentă este incorectă.' });
    return;
  }

  const samePassword = await bcrypt.compare(parsed.data.newPassword, user.passwordHash);
  if (samePassword) {
    res.status(400).json({ message: 'Noua parolă trebuie să fie diferită de parola curentă.' });
    return;
  }

  const nextPasswordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: nextPasswordHash,
      mustChangePassword: false,
    },
  });

  await writeAudit(req, {
    tableName: 'users',
    recordId: updatedUser.id,
    action: 'UPDATE_PASSWORD',
    reason: user.mustChangePassword ? 'mandatory-initial-password-change' : 'user-password-change',
    afterData: {
      mustChangePassword: updatedUser.mustChangePassword,
    },
  });

  await revokeAllActiveRefreshSessions(updatedUser.id);

  const publicUser = await issueLoginSession(updatedUser, req, res, {
    companySelectionRequired: req.user?.companySelectionRequired === true,
  });
  const userWithContext = await buildUserAuthContext(req, publicUser);
  res.json({ user: userWithContext });
});

router.post('/refresh', async (req, res) => {
  const refreshToken = getRefreshToken(req);
  if (!refreshToken) {
    clearAuthCookies(res);
    res.status(401).json({ message: 'Sesiune expirată. Reautentificare necesară.' });
    return;
  }

  const user = await rotateRefreshSession(req, res, refreshToken);
  if (!user) {
    clearAuthCookies(res);
    res.status(401).json({ message: 'Refresh token invalid sau expirat.' });
    return;
  }

  const userWithContext = await buildUserAuthContext(req, user);
  res.json({ user: userWithContext });
});

router.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      mustChangePassword: true,
      mfaEnabled: true,
    },
  });

  if (!user) {
    clearAuthCookies(res);
    res.status(404).json({ message: 'Utilizator inexistent.' });
    return;
  }

  const userWithContext = await buildUserAuthContext(req, {
    ...user,
    companySelectionRequired: req.user?.companySelectionRequired === true,
  });
  res.json({ user: userWithContext });
});

router.post('/logout', async (req, res) => {
  const refreshToken = getRefreshToken(req);
  if (refreshToken) {
    await revokeRefreshSessionByToken(refreshToken);
  }

  clearAuthCookies(res);
  res.status(204).send();
});

export default router;
