import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { env } from '../config/env.js';
import { dispatchNotificationEvent } from '../services/notifications/notification-service.js';
import type { NotificationEvent } from '../services/notifications/types.js';
import { logger } from './logger.js';

type QueueMode = 'memory' | 'bull';

const QUEUE_NAME = 'notification-events';
const MAX_IN_MEMORY_QUEUE_SIZE = 2_000;

let queueMode: QueueMode | null = null;
let workerBootstrapped = false;

let inMemoryQueue: NotificationEvent[] = [];
let pollTimer: NodeJS.Timeout | null = null;
let isTickRunning = false;

let bullQueue: Queue<NotificationEvent> | null = null;
let bullWorker: Worker<NotificationEvent> | null = null;

function resolveQueueMode(): QueueMode {
  if (env.NOTIFICATION_QUEUE_MODE === 'memory') {
    return 'memory';
  }
  if (env.NOTIFICATION_QUEUE_MODE === 'bull') {
    return 'bull';
  }
  return env.REDIS_URL ? 'bull' : 'memory';
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

function withDefaultMetadata(event: NotificationEvent): NotificationEvent {
  return {
    ...event,
    eventId: event.eventId ?? `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  };
}

async function processNotificationEvent(event: NotificationEvent): Promise<void> {
  try {
    await dispatchNotificationEvent(event);
  } catch (error) {
    logger.error('notification_event_processing_failed', {
      eventType: event.type,
      eventId: event.eventId ?? null,
      companyId: event.companyId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error },
    });
  }
}

async function tickInMemoryWorker(): Promise<void> {
  if (isTickRunning) {
    return;
  }

  isTickRunning = true;
  try {
    const nextEvent = inMemoryQueue.shift();
    if (!nextEvent) {
      return;
    }
    await processNotificationEvent(nextEvent);
  } finally {
    isTickRunning = false;
  }
}

function startInMemoryWorker(): void {
  if (pollTimer) {
    return;
  }

  pollTimer = setInterval(() => {
    void tickInMemoryWorker();
  }, env.NOTIFICATION_POLL_INTERVAL_MS);
  pollTimer.unref?.();

  void tickInMemoryWorker();
}

async function startBullWorker(): Promise<void> {
  if (bullQueue && bullWorker) {
    return;
  }
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL lipsește pentru modul Bull.');
  }

  const queueConnection = buildRedisConnectionOptions();
  const workerConnection = buildRedisConnectionOptions();
  bullQueue = new Queue<NotificationEvent>(QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 200,
    },
  });

  bullWorker = new Worker<NotificationEvent>(
    QUEUE_NAME,
    async (job) => {
      await processNotificationEvent(job.data);
    },
    {
      connection: workerConnection,
      concurrency: env.NOTIFICATION_BULL_CONCURRENCY,
    },
  );

  bullWorker.on('error', (error) => {
    logger.error('notification_queue_worker_error', {
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error },
    });
  });

  queueMode = 'bull';
}

export async function enqueueNotificationEvent(event: NotificationEvent): Promise<void> {
  if (!env.NOTIFICATIONS_ENABLED) {
    return;
  }

  const eventWithMetadata = withDefaultMetadata(event);
  if (!workerBootstrapped) {
    await processNotificationEvent(eventWithMetadata);
    return;
  }

  if (queueMode === 'bull' && bullQueue) {
    await bullQueue.add('dispatch', eventWithMetadata);
    return;
  }

  if (inMemoryQueue.length >= MAX_IN_MEMORY_QUEUE_SIZE) {
    inMemoryQueue.shift();
    logger.warn('notification_queue_overflow_drop_oldest', {
      maxSize: MAX_IN_MEMORY_QUEUE_SIZE,
    });
  }

  inMemoryQueue.push(eventWithMetadata);
}

export function startNotificationWorker(): void {
  if (workerBootstrapped || !env.NOTIFICATIONS_ENABLED) {
    return;
  }

  workerBootstrapped = true;
  const preferredMode = resolveQueueMode();
  if (preferredMode === 'memory') {
    queueMode = 'memory';
    startInMemoryWorker();
    logger.info('notification_queue_started', {
      mode: 'memory',
      pollIntervalMs: env.NOTIFICATION_POLL_INTERVAL_MS,
    });
    return;
  }

  void startBullWorker()
    .then(() => {
      logger.info('notification_queue_started', {
        mode: 'bull',
        concurrency: env.NOTIFICATION_BULL_CONCURRENCY,
      });
    })
    .catch((error) => {
      logger.warn('notification_queue_bull_fallback_memory', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { value: error },
      });
      queueMode = 'memory';
      startInMemoryWorker();
    });
}

export function stopNotificationWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  inMemoryQueue = [];

  if (bullWorker) {
    void bullWorker.close();
    bullWorker = null;
  }
  if (bullQueue) {
    void bullQueue.close();
    bullQueue = null;
  }

  queueMode = null;
  workerBootstrapped = false;
  isTickRunning = false;
}

export const __internal = {
  async flushInMemoryQueue(): Promise<void> {
    while (inMemoryQueue.length > 0) {
      await tickInMemoryWorker();
    }
  },
  getInMemoryQueueSize(): number {
    return inMemoryQueue.length;
  },
};
