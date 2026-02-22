import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { requirePermissions } from '../middleware/auth.js';

const router = Router();

router.get('/', requirePermissions(PERMISSIONS.AUDIT_READ), async (req, res) => {
  const take = Number(req.query.take ?? 200);

  const logs = await prisma.auditLog.findMany({
    where: {
      companyId: req.user!.companyId!,
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
        },
      },
    },
    orderBy: [{ timestamp: 'desc' }],
    take: Number.isFinite(take) ? Math.min(take, 1000) : 200,
  });

  res.json(logs);
});

export default router;
