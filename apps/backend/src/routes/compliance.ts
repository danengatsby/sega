import { Role } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions, requireRoles } from '../middleware/auth.js';

const router = Router();

const DEFAULT_AUDIT_RETENTION_DAYS = 3650;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

const retentionRunSchema = z.object({
  retentionDays: z.coerce.number().int().min(1).max(36500).optional(),
  dryRun: z.boolean().optional(),
  reason: z.string().max(256).optional(),
});

function resolveCutoffDate(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * ONE_DAY_IN_MS);
}

router.get('/report', requirePermissions(PERMISSIONS.AUDIT_READ), async (req, res) => {
  const now = new Date();
  const retentionDays = DEFAULT_AUDIT_RETENTION_DAYS;
  const cutoffDate = resolveCutoffDate(now, retentionDays);
  const companyId = req.user!.companyId!;

  const [totalAuditLogs, staleAuditLogs, oldestAuditLog] = await Promise.all([
    prisma.auditLog.count({
      where: {
        companyId,
      },
    }),
    prisma.auditLog.count({
      where: {
        companyId,
        timestamp: {
          lt: cutoffDate,
        },
      },
    }),
    prisma.auditLog.findFirst({
      where: {
        companyId,
      },
      orderBy: [{ timestamp: 'asc' }],
      select: {
        id: true,
        timestamp: true,
      },
    }),
  ]);

  res.json({
    generatedAt: now.toISOString(),
    companyId,
    retentionPolicy: {
      retentionDays,
      cutoffDate: cutoffDate.toISOString(),
      legalReference: 'Legea contabilității 82/1991 art. 25 (retenție 10 ani)',
    },
    auditLog: {
      totalRecords: totalAuditLogs,
      staleRecords: staleAuditLogs,
      oldestRecord: oldestAuditLog
        ? {
            id: oldestAuditLog.id,
            timestamp: oldestAuditLog.timestamp.toISOString(),
          }
        : null,
    },
    controls: {
      auditReadRestrictedByPermission: true,
      retentionRunRequiresPrivilegedRole: true,
      zeroTrustApiAuth: true,
    },
  });
});

router.post('/retention/run', requireRoles(Role.ADMIN, Role.CHIEF_ACCOUNTANT), async (req, res) => {
  const parsed = retentionRunSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru rularea retenției audit.' });
    return;
  }

  const now = new Date();
  const retentionDays = parsed.data.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS;
  const dryRun = parsed.data.dryRun === true;
  const cutoffDate = resolveCutoffDate(now, retentionDays);
  const companyId = req.user!.companyId!;

  const result = await prisma.$transaction(async (tx) => {
    const candidates = await tx.auditLog.count({
      where: {
        companyId,
        timestamp: {
          lt: cutoffDate,
        },
      },
    });

    const deleted = dryRun
      ? 0
      : (
          await tx.auditLog.deleteMany({
            where: {
              companyId,
              timestamp: {
                lt: cutoffDate,
              },
            },
          })
        ).count;

    await writeAudit(
      req,
      {
        tableName: 'AuditLog',
        action: 'COMPLIANCE_RETENTION_RUN',
        reason: parsed.data.reason ?? (dryRun ? 'compliance-retention-dry-run' : 'compliance-retention-run'),
        companyId,
        beforeData: {
          retentionDays,
          cutoffDate: cutoffDate.toISOString(),
          candidates,
          dryRun,
        },
        afterData: {
          retentionDays,
          cutoffDate: cutoffDate.toISOString(),
          deleted,
          dryRun,
        },
      },
      tx,
    );

    return {
      candidates,
      deleted,
    };
  });

  res.json({
    generatedAt: now.toISOString(),
    companyId,
    retentionDays,
    cutoffDate: cutoffDate.toISOString(),
    dryRun,
    candidates: result.candidates,
    deleted: result.deleted,
  });
});

export default router;
