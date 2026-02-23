import type { Prisma } from '@prisma/client';
import { ExportJobKind, ExportJobStatus } from '@prisma/client';
import { Router } from 'express';
import { HttpError } from '../lib/http-error.js';
import { parseListQuery, setPaginationHeaders } from '../lib/list-query.js';
import { prisma } from '../lib/prisma.js';
import { PERMISSIONS } from '../lib/rbac.js';
import { writeAudit } from '../lib/audit.js';
import { enqueueExportJob } from '../lib/export-job-queue.js';
import { requirePermissions } from '../middleware/auth.js';
import { createExportJobSchema, toCreatePayload } from '../services/export-jobs-service.js';

const router = Router();

const exportJobSortFields = ['createdAt', 'status', 'kind', 'finishedAt', 'attempts'] as const;
type ExportJobSortField = (typeof exportJobSortFields)[number];

const exportJobKinds = new Set<ExportJobKind>(Object.values(ExportJobKind));
const exportJobStatuses = new Set<ExportJobStatus>(Object.values(ExportJobStatus));

function buildExportJobOrderBy(
  sortField: ExportJobSortField,
  sortDirection: Prisma.SortOrder,
): Prisma.ExportJobOrderByWithRelationInput[] {
  switch (sortField) {
    case 'status':
      return [{ status: sortDirection }, { createdAt: 'desc' }];
    case 'kind':
      return [{ kind: sortDirection }, { createdAt: 'desc' }];
    case 'finishedAt':
      return [{ finishedAt: sortDirection }, { createdAt: 'desc' }];
    case 'attempts':
      return [{ attempts: sortDirection }, { createdAt: 'desc' }];
    case 'createdAt':
    default:
      return [{ createdAt: sortDirection }, { id: 'desc' }];
  }
}

const jobSelect = {
  id: true,
  companyId: true,
  createdById: true,
  kind: true,
  status: true,
  attempts: true,
  maxAttempts: true,
  errorMessage: true,
  resultMimeType: true,
  resultFilename: true,
  resultSizeBytes: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

router.post('/', requirePermissions(PERMISSIONS.EXPORT_JOBS_WRITE), async (req, res) => {
  const parsed = createExportJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Date invalide pentru crearea job-ului de export.' });
    return;
  }

  const companyId = req.user!.companyId!;

  const createdJob = await prisma.$transaction(async (tx) => {
    const job = await tx.exportJob.create({
      data: {
        companyId,
        createdById: req.user!.id,
        kind: parsed.data.kind,
        maxAttempts: parsed.data.maxAttempts,
        payload: toCreatePayload(parsed.data),
      },
      select: jobSelect,
    });

    await writeAudit(
      req,
      {
        tableName: 'export_jobs',
        recordId: job.id,
        action: 'CREATE',
        reason: 'queue-export',
        afterData: {
          kind: job.kind,
          status: job.status,
          maxAttempts: job.maxAttempts,
        },
      },
      tx,
    );

    return job;
  });

  await enqueueExportJob(createdJob.id);
  res.status(202).json(createdJob);
});

router.get('/', requirePermissions(PERMISSIONS.EXPORT_JOBS_READ), async (req, res) => {
  const query = parseListQuery(req.query as Record<string, unknown>, {
    allowedSortFields: exportJobSortFields,
    defaultSortField: 'createdAt',
    defaultSortDirection: 'desc',
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  const searched = query.search?.toUpperCase();
  const whereOrConditions: Prisma.ExportJobWhereInput[] = query.search
    ? [{ errorMessage: { contains: query.search, mode: 'insensitive' } }]
    : [];

  if (searched && exportJobKinds.has(searched as ExportJobKind)) {
    whereOrConditions.push({ kind: searched as ExportJobKind });
  }

  if (searched && exportJobStatuses.has(searched as ExportJobStatus)) {
    whereOrConditions.push({ status: searched as ExportJobStatus });
  }

  const baseWhere: Prisma.ExportJobWhereInput = {
    companyId: req.user!.companyId!,
  };

  const searchWhere: Prisma.ExportJobWhereInput | undefined =
    whereOrConditions.length > 0
      ? {
          OR: whereOrConditions,
        }
      : undefined;

  const where: Prisma.ExportJobWhereInput = searchWhere
    ? {
        AND: [baseWhere, searchWhere],
      }
    : baseWhere;

  const orderBy = buildExportJobOrderBy(query.sortField, query.sortDirection);

  const [jobs, totalCount] = await Promise.all([
    prisma.exportJob.findMany({
      where,
      orderBy,
      skip: query.skip,
      take: query.take,
      select: jobSelect,
    }),
    prisma.exportJob.count({ where }),
  ]);

  if (query.paginationEnabled) {
    setPaginationHeaders(res, {
      totalCount,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  res.json(jobs);
});

router.get('/:id', requirePermissions(PERMISSIONS.EXPORT_JOBS_READ), async (req, res) => {
  const job = await prisma.exportJob.findFirst({
    where: {
      id: String(req.params.id),
      companyId: req.user!.companyId!,
    },
    select: jobSelect,
  });

  if (!job) {
    throw HttpError.notFound('Job-ul de export nu există.');
  }

  res.json(job);
});

router.get('/:id/download', requirePermissions(PERMISSIONS.EXPORT_JOBS_READ), async (req, res) => {
  const job = await prisma.exportJob.findFirst({
    where: {
      id: String(req.params.id),
      companyId: req.user!.companyId!,
    },
    select: {
      id: true,
      status: true,
      resultStorageUrl: true,
      resultSignedUrl: true,
      resultSignedUrlExpiresAt: true,
      resultFilename: true,
      resultMimeType: true,
    },
  });

  if (!job) {
    throw HttpError.notFound('Job-ul de export nu există.');
  }

  if (job.status !== ExportJobStatus.DONE) {
    throw HttpError.conflict('Rezultatul job-ului nu este încă disponibil pentru descărcare.');
  }

  const signedUrlExpired =
    job.resultSignedUrlExpiresAt !== null &&
    job.resultSignedUrlExpiresAt.getTime() <= Date.now() + 30_000;

  if (job.resultSignedUrl && !signedUrlExpired) {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, job.resultSignedUrl);
    return;
  }

  if (job.resultStorageUrl) {
    throw HttpError.conflict('URL-ul de descărcare a expirat. Regenerarea semnăturii va fi disponibilă într-o actualizare următoare.');
  }

  throw HttpError.conflict('Rezultatul exportului nu este disponibil pentru descărcare în acest mediu.');
});

export default router;
