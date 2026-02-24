import { Role } from '@prisma/client';
import bcrypt from 'bcrypt';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

const companyCodePattern = /^[A-Za-z0-9._-]+$/;
const requestIdHeaderName = 'x-request-id';

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
  isActive: z.boolean().optional(),
  reason: z.string().max(256).optional(),
});

const companyUpdateSchema = z
  .object({
    name: z.string().min(2).max(180).optional(),
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
    isActive: z.boolean().optional(),
    reason: z.string().max(256).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'reason'), {
    message: 'Cel puțin un câmp de actualizare este obligatoriu.',
  });

const membershipInputSchema = z.object({
  companyId: z.string().uuid(),
  role: z.nativeEnum(Role),
  isDefault: z.boolean().optional(),
});

const userCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(160),
  password: z.string().min(12).max(128),
  role: z.nativeEnum(Role),
  mfaEnabled: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
  memberships: z.array(membershipInputSchema).min(1),
  reason: z.string().max(256).optional(),
});

const userUpdateSchema = z
  .object({
    name: z.string().min(2).max(160).optional(),
    role: z.nativeEnum(Role).optional(),
    mfaEnabled: z.boolean().optional(),
    mustChangePassword: z.boolean().optional(),
    reason: z.string().max(256).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'reason'), {
    message: 'Cel puțin un câmp de actualizare este obligatoriu.',
  });

const resetPasswordSchema = z.object({
  newPassword: z.string().min(12).max(128),
  reason: z.string().max(256).optional(),
});

const membershipCreateSchema = z.object({
  userId: z.string().uuid(),
  companyId: z.string().uuid(),
  role: z.nativeEnum(Role),
  isDefault: z.boolean().optional(),
  reason: z.string().max(256).optional(),
});

const membershipUpdateSchema = z
  .object({
    role: z.nativeEnum(Role).optional(),
    isDefault: z.boolean().optional(),
    reason: z.string().max(256).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'reason'), {
    message: 'Cel puțin un câmp de actualizare este obligatoriu.',
  });

type UserPublicShape = {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function requireGlobalAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ message: 'Neautentificat.' });
    return;
  }

  if (req.user.role !== Role.ADMIN) {
    res.status(403).json({ message: 'Doar administratorii globali pot accesa acest modul.' });
    return;
  }

  next();
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

function sanitizeUserForResponse(user: UserPublicShape): UserPublicShape {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function requestIdFromHeaders(req: Request): string | null {
  const header = req.headers[requestIdHeaderName];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildAuditSnapshotEnvelope(req: Request, data: unknown): {
  requestId: string | null;
  actor: { id: string | null; email: string | null; role: Role | null; sessionId: string | null };
  data: unknown;
} {
  const actorRole = req.user?.companyRole ?? req.user?.role ?? null;
  return {
    requestId: requestIdFromHeaders(req),
    actor: {
      id: req.user?.id ?? null,
      email: req.user?.email ?? null,
      role: actorRole,
      sessionId: req.user?.sessionId ?? null,
    },
    data,
  };
}

router.use(requireGlobalAdmin);

router.get('/companies', async (_req, res) => {
  const companies = await prisma.company.findMany({
    orderBy: [{ createdAt: 'desc' }],
  });
  res.json(companies);
});

router.post('/companies', async (req, res, next) => {
  const parsed = companyCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru crearea companiei.' });
    return;
  }

  try {
    const company = await prisma.$transaction(async (tx) => {
      const created = await tx.company.create({
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
          isActive: parsed.data.isActive ?? true,
        },
      });

      await writeAudit(
        req,
        {
          tableName: 'Company',
          recordId: created.id,
          action: 'ADMIN_COMPANY_CREATE',
          reason: parsed.data.reason,
          companyId: created.id,
          beforeData: buildAuditSnapshotEnvelope(req, { exists: false }),
          afterData: buildAuditSnapshotEnvelope(req, created),
        },
        tx,
      );

      return created;
    });

    res.status(201).json(company);
  } catch (error) {
    if (isPrismaKnownError(error, 'P2002')) {
      res.status(409).json({ message: 'Codul companiei există deja.' });
      return;
    }
    next(error);
  }
});

router.patch('/companies/:id', async (req, res, next) => {
  const parsed = companyUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru actualizarea companiei.' });
    return;
  }

  const companyId = String(req.params.id);

  try {
    const updatedCompany = await prisma.$transaction(async (tx) => {
      const existing = await tx.company.findUnique({
        where: { id: companyId },
      });

      if (!existing) {
        return null;
      }

      const updated = await tx.company.update({
        where: { id: companyId },
        data: {
          name: parsed.data.name?.trim(),
          cui: parsed.data.cui !== undefined ? normalizeOptionalString(parsed.data.cui) : undefined,
          registrationNumber:
            parsed.data.registrationNumber !== undefined
              ? normalizeOptionalString(parsed.data.registrationNumber)
              : undefined,
          address: parsed.data.address !== undefined ? normalizeOptionalString(parsed.data.address) : undefined,
          city: parsed.data.city !== undefined ? normalizeOptionalString(parsed.data.city) : undefined,
          county: parsed.data.county !== undefined ? normalizeOptionalString(parsed.data.county) : undefined,
          country: parsed.data.country !== undefined ? normalizeOptionalString(parsed.data.country) : undefined,
          bankName: parsed.data.bankName !== undefined ? normalizeOptionalString(parsed.data.bankName) : undefined,
          iban: parsed.data.iban !== undefined ? normalizeOptionalString(parsed.data.iban) : undefined,
          email: parsed.data.email !== undefined ? normalizeOptionalString(parsed.data.email) : undefined,
          phone: parsed.data.phone !== undefined ? normalizeOptionalString(parsed.data.phone) : undefined,
          isActive: parsed.data.isActive,
        },
      });

      await writeAudit(
        req,
        {
          tableName: 'Company',
          recordId: updated.id,
          action: 'ADMIN_COMPANY_UPDATE',
          reason: parsed.data.reason,
          companyId: updated.id,
          beforeData: buildAuditSnapshotEnvelope(req, existing),
          afterData: buildAuditSnapshotEnvelope(req, updated),
        },
        tx,
      );

      return updated;
    });

    if (!updatedCompany) {
      res.status(404).json({ message: 'Compania nu există.' });
      return;
    }

    res.json(updatedCompany);
  } catch (error) {
    if (isPrismaKnownError(error, 'P2002')) {
      res.status(409).json({ message: 'Codul companiei există deja.' });
      return;
    }
    next(error);
  }
});

router.delete('/companies/:id', async (req, res, next) => {
  const companyId = String(req.params.id);

  try {
    const deleted = await prisma.$transaction(async (tx) => {
      const existing = await tx.company.findUnique({
        where: { id: companyId },
      });

      if (!existing) {
        return false;
      }

      await writeAudit(
        req,
        {
          tableName: 'Company',
          recordId: existing.id,
          action: 'ADMIN_COMPANY_DELETE',
          companyId: existing.id,
          beforeData: buildAuditSnapshotEnvelope(req, existing),
          afterData: buildAuditSnapshotEnvelope(req, { exists: false }),
        },
        tx,
      );

      await tx.company.delete({
        where: { id: companyId },
      });

      return true;
    });

    if (!deleted) {
      res.status(404).json({ message: 'Compania nu există.' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    if (isPrismaKnownError(error, 'P2003')) {
      res.status(409).json({ message: 'Compania nu poate fi ștearsă deoarece există referințe active.' });
      return;
    }
    next(error);
  }
});

router.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      mustChangePassword: true,
      mfaEnabled: true,
      createdAt: true,
      updatedAt: true,
      memberships: {
        select: {
          id: true,
          companyId: true,
          role: true,
          isDefault: true,
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
  });

  res.json(users);
});

router.post('/users', async (req, res, next) => {
  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru crearea utilizatorului.' });
    return;
  }

  try {
    const createdUser = await prisma.$transaction(async (tx) => {
      const distinctCompanyIds = [...new Set(parsed.data.memberships.map((membership) => membership.companyId))];
      const companiesCount = await tx.company.count({
        where: {
          id: {
            in: distinctCompanyIds,
          },
          isActive: true,
        },
      });
      if (companiesCount !== distinctCompanyIds.length) {
        throw new Error('ADMIN_INVALID_MEMBERSHIP_COMPANY');
      }

      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const user = await tx.user.create({
        data: {
          email: normalizeEmail(parsed.data.email),
          name: parsed.data.name.trim(),
          passwordHash,
          role: parsed.data.role,
          mfaEnabled: parsed.data.mfaEnabled ?? false,
          mfaSecret: null,
          mfaPendingSecret: null,
          mustChangePassword: parsed.data.mustChangePassword ?? true,
        },
      });

      const defaultMembershipIndex = parsed.data.memberships.findIndex((membership) => membership.isDefault === true);
      const membershipsToCreate = parsed.data.memberships.map((membership, index) => ({
        userId: user.id,
        companyId: membership.companyId,
        role: membership.role,
        isDefault: defaultMembershipIndex >= 0 ? index === defaultMembershipIndex : index === 0,
      }));

      await tx.userCompanyMembership.createMany({
        data: membershipsToCreate,
      });

      await writeAudit(
        req,
        {
          tableName: 'User',
          recordId: user.id,
          action: 'ADMIN_USER_CREATE',
          reason: parsed.data.reason,
          beforeData: buildAuditSnapshotEnvelope(req, { exists: false }),
          afterData: buildAuditSnapshotEnvelope(req, sanitizeUserForResponse(user)),
        },
        tx,
      );

      return user;
    });

    res.status(201).json(sanitizeUserForResponse(createdUser));
  } catch (error) {
    if (error instanceof Error && error.message === 'ADMIN_INVALID_MEMBERSHIP_COMPANY') {
      res.status(404).json({ message: 'Una sau mai multe companii din memberships nu există sau sunt inactive.' });
      return;
    }
    if (isPrismaKnownError(error, 'P2002')) {
      res.status(409).json({ message: 'Email-ul utilizatorului există deja.' });
      return;
    }
    next(error);
  }
});

router.patch('/users/:id', async (req, res, next) => {
  const parsed = userUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru actualizarea utilizatorului.' });
    return;
  }

  const userId = String(req.params.id);

  try {
    const updatedUser = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id: userId },
      });
      if (!existing) {
        return null;
      }

      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          name: parsed.data.name?.trim(),
          role: parsed.data.role,
          mfaEnabled: parsed.data.mfaEnabled,
          mustChangePassword: parsed.data.mustChangePassword,
        },
      });

      await writeAudit(
        req,
        {
          tableName: 'User',
          recordId: updated.id,
          action: 'ADMIN_USER_UPDATE',
          reason: parsed.data.reason,
          beforeData: buildAuditSnapshotEnvelope(req, sanitizeUserForResponse(existing)),
          afterData: buildAuditSnapshotEnvelope(req, sanitizeUserForResponse(updated)),
        },
        tx,
      );

      return updated;
    });

    if (!updatedUser) {
      res.status(404).json({ message: 'Utilizatorul nu există.' });
      return;
    }

    res.json(sanitizeUserForResponse(updatedUser));
  } catch (error) {
    next(error);
  }
});

router.post('/users/:id/reset-password', async (req, res, next) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru resetarea parolei.' });
    return;
  }

  const userId = String(req.params.id);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id: userId },
      });
      if (!existing) {
        return null;
      }

      const activeSessions = await tx.refreshSession.count({
        where: {
          userId: existing.id,
          revokedAt: null,
        },
      });

      const nextPasswordHash = await bcrypt.hash(parsed.data.newPassword, 12);
      const updated = await tx.user.update({
        where: { id: existing.id },
        data: {
          passwordHash: nextPasswordHash,
          mustChangePassword: true,
        },
      });

      const revokedSessions = await tx.refreshSession.updateMany({
        where: {
          userId: existing.id,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });

      const existingPublic = sanitizeUserForResponse(existing);
      const updatedPublic = sanitizeUserForResponse(updated);

      await writeAudit(
        req,
        {
          tableName: 'User',
          recordId: updated.id,
          action: 'ADMIN_USER_RESET_PASSWORD',
          reason: parsed.data.reason,
          beforeData: buildAuditSnapshotEnvelope(req, {
            user: existingPublic,
            activeSessions,
          }),
          afterData: buildAuditSnapshotEnvelope(req, {
            user: updatedPublic,
            revokedSessions: revokedSessions.count,
          }),
        },
        tx,
      );

      return {
        user: updatedPublic,
        revokedSessions: revokedSessions.count,
      };
    });

    if (!result) {
      res.status(404).json({ message: 'Utilizatorul nu există.' });
      return;
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/users/:id', async (req, res, next) => {
  const userId = String(req.params.id);

  if (req.user?.id === userId) {
    res.status(409).json({ message: 'Administratorul curent nu își poate șterge propriul cont.' });
    return;
  }

  try {
    const deleted = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id: userId },
      });
      if (!existing) {
        return false;
      }

      await tx.user.delete({
        where: { id: userId },
      });

      await writeAudit(
        req,
        {
          tableName: 'User',
          recordId: userId,
          action: 'ADMIN_USER_DELETE',
          beforeData: buildAuditSnapshotEnvelope(req, sanitizeUserForResponse(existing)),
          afterData: buildAuditSnapshotEnvelope(req, { exists: false }),
        },
        tx,
      );

      return true;
    });

    if (!deleted) {
      res.status(404).json({ message: 'Utilizatorul nu există.' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    if (isPrismaKnownError(error, 'P2003')) {
      res.status(409).json({ message: 'Utilizatorul nu poate fi șters deoarece există referințe active.' });
      return;
    }
    next(error);
  }
});

router.get('/memberships', async (_req, res) => {
  const memberships = await prisma.userCompanyMembership.findMany({
    include: {
      company: {
        select: {
          id: true,
          code: true,
          name: true,
          isActive: true,
        },
      },
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
  });

  res.json(memberships);
});

router.post('/memberships', async (req, res, next) => {
  const parsed = membershipCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru crearea membership-ului.' });
    return;
  }

  try {
    const membership = await prisma.$transaction(async (tx) => {
      const [userExists, company] = await Promise.all([
        tx.user.findUnique({
          where: { id: parsed.data.userId },
          select: { id: true },
        }),
        tx.company.findUnique({
          where: { id: parsed.data.companyId },
          select: { id: true, isActive: true },
        }),
      ]);

      if (!userExists) {
        throw new Error('ADMIN_MEMBERSHIP_USER_NOT_FOUND');
      }

      if (!company || !company.isActive) {
        throw new Error('ADMIN_MEMBERSHIP_COMPANY_NOT_FOUND');
      }

      if (parsed.data.isDefault === true) {
        await tx.userCompanyMembership.updateMany({
          where: {
            userId: parsed.data.userId,
            isDefault: true,
          },
          data: {
            isDefault: false,
          },
        });
      }

      const created = await tx.userCompanyMembership.create({
        data: {
          userId: parsed.data.userId,
          companyId: parsed.data.companyId,
          role: parsed.data.role,
          isDefault: parsed.data.isDefault ?? false,
        },
      });

      await writeAudit(
        req,
        {
          tableName: 'UserCompanyMembership',
          recordId: created.id,
          action: 'ADMIN_MEMBERSHIP_CREATE',
          reason: parsed.data.reason,
          companyId: created.companyId,
          beforeData: buildAuditSnapshotEnvelope(req, { exists: false }),
          afterData: buildAuditSnapshotEnvelope(req, created),
        },
        tx,
      );

      return created;
    });

    res.status(201).json(membership);
  } catch (error) {
    if (error instanceof Error && error.message === 'ADMIN_MEMBERSHIP_USER_NOT_FOUND') {
      res.status(404).json({ message: 'Utilizatorul pentru membership nu există.' });
      return;
    }
    if (error instanceof Error && error.message === 'ADMIN_MEMBERSHIP_COMPANY_NOT_FOUND') {
      res.status(404).json({ message: 'Compania pentru membership nu există sau este inactivă.' });
      return;
    }
    if (isPrismaKnownError(error, 'P2002')) {
      res.status(409).json({ message: 'Membership-ul pentru această pereche user-companie există deja.' });
      return;
    }
    next(error);
  }
});

router.patch('/memberships/:id', async (req, res, next) => {
  const parsed = membershipUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru actualizarea membership-ului.' });
    return;
  }

  const membershipId = String(req.params.id);

  try {
    const updatedMembership = await prisma.$transaction(async (tx) => {
      const existing = await tx.userCompanyMembership.findUnique({
        where: { id: membershipId },
      });
      if (!existing) {
        return null;
      }

      if (parsed.data.isDefault === true) {
        await tx.userCompanyMembership.updateMany({
          where: {
            userId: existing.userId,
            isDefault: true,
          },
          data: {
            isDefault: false,
          },
        });
      }

      const updated = await tx.userCompanyMembership.update({
        where: { id: membershipId },
        data: {
          role: parsed.data.role,
          isDefault: parsed.data.isDefault,
        },
      });

      await writeAudit(
        req,
        {
          tableName: 'UserCompanyMembership',
          recordId: updated.id,
          action: 'ADMIN_MEMBERSHIP_UPDATE',
          reason: parsed.data.reason,
          companyId: updated.companyId,
          beforeData: buildAuditSnapshotEnvelope(req, existing),
          afterData: buildAuditSnapshotEnvelope(req, updated),
        },
        tx,
      );

      return updated;
    });

    if (!updatedMembership) {
      res.status(404).json({ message: 'Membership-ul nu există.' });
      return;
    }

    res.json(updatedMembership);
  } catch (error) {
    next(error);
  }
});

router.delete('/memberships/:id', async (req, res, next) => {
  const membershipId = String(req.params.id);

  try {
    const deleted = await prisma.$transaction(async (tx) => {
      const existing = await tx.userCompanyMembership.findUnique({
        where: { id: membershipId },
      });
      if (!existing) {
        return false;
      }

      await tx.userCompanyMembership.delete({
        where: { id: membershipId },
      });

      await writeAudit(
        req,
        {
          tableName: 'UserCompanyMembership',
          recordId: membershipId,
          action: 'ADMIN_MEMBERSHIP_DELETE',
          companyId: existing.companyId,
          beforeData: buildAuditSnapshotEnvelope(req, existing),
          afterData: buildAuditSnapshotEnvelope(req, { exists: false }),
        },
        tx,
      );

      return true;
    });

    if (!deleted) {
      res.status(404).json({ message: 'Membership-ul nu există.' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
