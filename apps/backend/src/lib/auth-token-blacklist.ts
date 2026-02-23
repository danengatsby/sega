import { Redis as RedisClient } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const BLACKLIST_KEY_PREFIX = 'sega:auth:blacklist:v1:sid';
const MEMORY_PRUNE_INTERVAL_MS = 30_000;

let redisClient: RedisClient | null = null;
let lastMemoryPruneAt = 0;
const inMemoryBlacklist = new Map<string, number>();

function buildBlacklistKey(sessionId: string): string {
  return `${BLACKLIST_KEY_PREFIX}:${sessionId}`;
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function pruneMemoryBlacklist(nowMs = Date.now()): void {
  if (nowMs - lastMemoryPruneAt < MEMORY_PRUNE_INTERVAL_MS) {
    return;
  }

  lastMemoryPruneAt = nowMs;
  for (const [sessionId, expiresAtMs] of inMemoryBlacklist.entries()) {
    if (expiresAtMs <= nowMs) {
      inMemoryBlacklist.delete(sessionId);
    }
  }
}

function getRedisClient(): RedisClient | null {
  if (!env.REDIS_URL) {
    return null;
  }

  if (!redisClient) {
    redisClient = new RedisClient(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    redisClient.on('error', (error: unknown) => {
      logger.warn('auth_blacklist_redis_error', {
        error: error instanceof Error ? { name: error.name, message: error.message } : { value: error },
      });
    });
  }

  return redisClient;
}

function blacklistInMemory(sessionId: string, expiresAtEpochSeconds: number): void {
  const nowMs = Date.now();
  const expiresAtMs = expiresAtEpochSeconds * 1000;
  if (expiresAtMs <= nowMs) {
    inMemoryBlacklist.delete(sessionId);
    return;
  }

  inMemoryBlacklist.set(sessionId, expiresAtMs);
  pruneMemoryBlacklist(nowMs);
}

function isBlacklistedInMemory(sessionId: string): boolean {
  const nowMs = Date.now();
  pruneMemoryBlacklist(nowMs);

  const expiresAtMs = inMemoryBlacklist.get(sessionId);
  if (!expiresAtMs) {
    return false;
  }

  if (expiresAtMs <= nowMs) {
    inMemoryBlacklist.delete(sessionId);
    return false;
  }

  return true;
}

export async function blacklistSessionId(sessionId: string, expiresAtEpochSeconds: number): Promise<void> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return;
  }

  const nowSeconds = nowEpochSeconds();
  if (!Number.isFinite(expiresAtEpochSeconds) || expiresAtEpochSeconds <= nowSeconds) {
    inMemoryBlacklist.delete(normalizedSessionId);
    return;
  }

  const ttlSeconds = Math.max(1, Math.ceil(expiresAtEpochSeconds - nowSeconds));
  const client = getRedisClient();
  if (client) {
    try {
      await client.set(buildBlacklistKey(normalizedSessionId), '1', 'EX', ttlSeconds);
      return;
    } catch (error) {
      logger.warn('auth_blacklist_redis_write_failed', {
        sessionId: normalizedSessionId,
        ttlSeconds,
        error: error instanceof Error ? { name: error.name, message: error.message } : { value: error },
      });
    }
  }

  blacklistInMemory(normalizedSessionId, expiresAtEpochSeconds);
}

export async function isSessionIdBlacklisted(sessionId: string): Promise<boolean> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return false;
  }

  const client = getRedisClient();
  if (client) {
    try {
      const keyExists = await client.exists(buildBlacklistKey(normalizedSessionId));
      if (keyExists > 0) {
        return true;
      }
    } catch (error) {
      logger.warn('auth_blacklist_redis_read_failed', {
        sessionId: normalizedSessionId,
        error: error instanceof Error ? { name: error.name, message: error.message } : { value: error },
      });
    }
  }

  return isBlacklistedInMemory(normalizedSessionId);
}

export const __internal = {
  clearInMemoryBlacklist(): void {
    inMemoryBlacklist.clear();
    lastMemoryPruneAt = 0;
  },
  inMemorySize(): number {
    return inMemoryBlacklist.size;
  },
};
