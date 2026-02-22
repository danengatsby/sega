import { ExportJobStatus } from '@prisma/client';
import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { executeExportJob } from '../services/export-jobs-service.js';

const EXPORT_QUEUE_NAME = 'export-jobs';

type QueueMode = 'poll' | 'bull';
type ExportQueuePayload = {
  exportJobId: string;
};

let workerInterval: NodeJS.Timeout | null = null;
let isTickRunning = false;

let exportQueue: Queue<ExportQueuePayload> | null = null;
let exportWorker: Worker<ExportQueuePayload> | null = null;
let queueMode: QueueMode | null = null;
let workerBootstrapped = false;

function resolveQueueMode(): QueueMode {
  if (env.EXPORT_JOB_QUEUE_MODE === 'poll') {
    return 'poll';
  }
  if (env.EXPORT_JOB_QUEUE_MODE === 'bull') {
    return 'bull';
  }
  return env.REDIS_URL ? 'bull' : 'poll';
}

function retryDelayMs(attempts: number): number {
  return Math.min(30_000, 3_000 * Math.max(attempts, 1));
}

function buildRedisConnectionOptions(): ConnectionOptions {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL lipsește.');
  }

  const redisUrl = new URL(env.REDIS_URL);
  const dbValue = redisUrl.pathname.startsWith('/') ? Number(redisUrl.pathname.slice(1) || '0') : 0;

  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || '6379'),
    username: redisUrl.username || undefined,
    password: redisUrl.password || undefined,
    db: Number.isFinite(dbValue) ? dbValue : 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}

async function processSingleQueuedJob(forcedJobId?: string): Promise<void> {
  const queuedJob = forcedJobId
    ? await prisma.exportJob.findFirst({
        where: {
          id: forcedJobId,
          status: ExportJobStatus.QUEUED,
        },
      })
    : await prisma.exportJob.findFirst({
        where: {
          status: ExportJobStatus.QUEUED,
        },
        orderBy: [{ createdAt: 'asc' }],
      });

  if (!queuedJob) {
    return;
  }

  const claimed = await prisma.exportJob.updateMany({
    where: {
      id: queuedJob.id,
      status: ExportJobStatus.QUEUED,
    },
    data: {
      status: ExportJobStatus.PROCESSING,
      startedAt: new Date(),
      finishedAt: null,
      errorMessage: null,
      attempts: {
        increment: 1,
      },
    },
  });

  if (claimed.count === 0) {
    return;
  }

  const job = await prisma.exportJob.findUnique({
    where: { id: queuedJob.id },
  });

  if (!job) {
    return;
  }

  try {
    const result = await executeExportJob(job);
    await prisma.exportJob.update({
      where: { id: job.id },
      data: {
        status: ExportJobStatus.DONE,
        resultData: result.data,
        resultMimeType: result.mimeType,
        resultFilename: result.filename,
        errorMessage: null,
        finishedAt: new Date(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Job-ul de export a eșuat.';
    const attemptsAfterClaim = job.attempts;
    const shouldRetry = attemptsAfterClaim < job.maxAttempts;

    await prisma.exportJob.update({
      where: { id: job.id },
      data: {
        status: shouldRetry ? ExportJobStatus.QUEUED : ExportJobStatus.FAILED,
        errorMessage: message.slice(0, 400),
        startedAt: shouldRetry ? null : job.startedAt,
        finishedAt: shouldRetry ? null : new Date(),
      },
    });

    if (shouldRetry && queueMode === 'bull') {
      await enqueueExportJob(job.id, {
        delay: retryDelayMs(attemptsAfterClaim),
      });
    }
  }
}

async function tickExportJobWorker(): Promise<void> {
  if (isTickRunning) {
    return;
  }

  isTickRunning = true;
  try {
    await processSingleQueuedJob();
  } finally {
    isTickRunning = false;
  }
}

async function bootstrapQueuedJobsInBull(): Promise<void> {
  if (!exportQueue) {
    return;
  }

  const pending = await prisma.exportJob.findMany({
    where: {
      status: ExportJobStatus.QUEUED,
    },
    select: {
      id: true,
    },
    orderBy: [{ createdAt: 'asc' }],
    take: 1_000,
  });

  for (const job of pending) {
    await enqueueExportJob(job.id);
  }
}

async function startBullWorker(): Promise<void> {
  if (exportQueue && exportWorker) {
    return;
  }
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL lipsește pentru modul Bull.');
  }

  const queueConnection = buildRedisConnectionOptions();
  const workerConnection = buildRedisConnectionOptions();

  exportQueue = new Queue<ExportQueuePayload>(EXPORT_QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 200,
    },
  });

  exportWorker = new Worker<ExportQueuePayload>(
    EXPORT_QUEUE_NAME,
    async (queueJob) => {
      await processSingleQueuedJob(queueJob.data.exportJobId);
    },
    {
      connection: workerConnection,
      concurrency: env.EXPORT_JOB_BULL_CONCURRENCY,
    },
  );

  exportWorker.on('error', (error) => {
    logger.error('export_queue_worker_error', {
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error },
    });
  });

  queueMode = 'bull';
  await bootstrapQueuedJobsInBull();
}

function startPollingWorker(): void {
  if (workerInterval) {
    return;
  }

  workerInterval = setInterval(() => {
    void tickExportJobWorker();
  }, env.EXPORT_JOB_POLL_INTERVAL_MS);

  void tickExportJobWorker();
}

export async function enqueueExportJob(jobId: string, options?: JobsOptions): Promise<void> {
  if (queueMode !== 'bull' || !exportQueue) {
    return;
  }

  try {
    await exportQueue.add(
      'execute',
      {
        exportJobId: jobId,
      },
      {
        jobId,
        ...options,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Job is already waiting') || message.includes('Job is already active')) {
      return;
    }
    logger.error('export_queue_enqueue_failed', {
      exportJobId: jobId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error },
    });
  }
}

export function startExportJobWorker(): void {
  if (workerBootstrapped) {
    return;
  }
  workerBootstrapped = true;

  const preferredMode = resolveQueueMode();
  if (preferredMode === 'poll') {
    queueMode = 'poll';
    startPollingWorker();
    return;
  }

  void startBullWorker().catch((error) => {
    logger.warn('export_queue_bull_fallback_poll', {
      error: error instanceof Error ? { name: error.name, message: error.message } : { value: error },
    });
    queueMode = 'poll';
    startPollingWorker();
  });
}

export function stopExportJobWorker(): void {
  if (!workerInterval) {
    workerInterval = null;
  } else {
    clearInterval(workerInterval);
    workerInterval = null;
  }

  if (exportWorker) {
    void exportWorker.close();
    exportWorker = null;
  }
  if (exportQueue) {
    void exportQueue.close();
    exportQueue = null;
  }
  queueMode = null;
  workerBootstrapped = false;
}
