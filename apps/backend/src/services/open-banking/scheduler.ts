import { OpenBankingConnectionStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { runOpenBankingSync } from './sync-service.js';

const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 20 * 60 * 60 * 1000;

let schedulerTimer: NodeJS.Timeout | null = null;
let lastTriggeredHourKey: string | null = null;

function hourKeyUtc(value: Date): string {
  return value.toISOString().slice(0, 13);
}

function shouldSyncConnectionNow(lastSyncedAt: Date | null): boolean {
  if (!lastSyncedAt) {
    return true;
  }
  return Date.now() - lastSyncedAt.getTime() >= MIN_SYNC_INTERVAL_MS;
}

async function runDailyOpenBankingSyncTick(): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() !== env.OPEN_BANKING_DAILY_SYNC_HOUR_UTC) {
    return;
  }

  const key = hourKeyUtc(now);
  if (lastTriggeredHourKey === key) {
    return;
  }
  lastTriggeredHourKey = key;

  const eligibleConnections = await prisma.openBankingConnection.findMany({
    where: {
      status: {
        in: [OpenBankingConnectionStatus.ACTIVE, OpenBankingConnectionStatus.ERROR],
      },
    },
    select: {
      id: true,
      companyId: true,
      lastSyncedAt: true,
    },
    orderBy: [{ updatedAt: 'asc' }],
    take: 200,
  });

  logger.info('open_banking_scheduler_tick', {
    hourUtc: env.OPEN_BANKING_DAILY_SYNC_HOUR_UTC,
    connectionsDiscovered: eligibleConnections.length,
  });

  for (const connection of eligibleConnections) {
    if (!shouldSyncConnectionNow(connection.lastSyncedAt)) {
      continue;
    }

    try {
      await runOpenBankingSync({
        connectionId: connection.id,
        companyId: connection.companyId,
        source: 'scheduler',
      });
    } catch (error) {
      logger.error('open_banking_scheduler_sync_failed', {
        connectionId: connection.id,
        companyId: connection.companyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function startOpenBankingScheduler(): void {
  if (!env.OPEN_BANKING_ENABLED) {
    logger.info('open_banking_scheduler_disabled', {
      reason: 'OPEN_BANKING_ENABLED=false',
    });
    return;
  }

  if (schedulerTimer) {
    return;
  }

  schedulerTimer = setInterval(() => {
    void runDailyOpenBankingSyncTick();
  }, SCHEDULER_INTERVAL_MS);

  void runDailyOpenBankingSyncTick();

  logger.info('open_banking_scheduler_started', {
    intervalMs: SCHEDULER_INTERVAL_MS,
    dailyHourUtc: env.OPEN_BANKING_DAILY_SYNC_HOUR_UTC,
  });
}

export function stopOpenBankingScheduler(): void {
  if (!schedulerTimer) {
    return;
  }
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}
