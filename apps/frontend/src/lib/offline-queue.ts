import type { ModuleKey } from '../app/navigation';

export type OfflineWriteMethod = 'POST' | 'PATCH' | 'DELETE';

export interface OfflineWriteOperation {
  id: string;
  userId: string;
  companyId: string | null;
  path: string;
  method: OfflineWriteMethod;
  body: unknown;
  moduleKey: ModuleKey;
  createdAt: string;
}

const STORAGE_KEY = 'sega.offline.write.queue.v1';

function isOfflineWriteMethod(value: unknown): value is OfflineWriteMethod {
  return value === 'POST' || value === 'PATCH' || value === 'DELETE';
}

function isOfflineWriteOperation(value: unknown): value is OfflineWriteOperation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<OfflineWriteOperation>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.userId === 'string' &&
    candidate.userId.length > 0 &&
    (candidate.companyId === null || typeof candidate.companyId === 'string') &&
    typeof candidate.path === 'string' &&
    candidate.path.startsWith('/') &&
    isOfflineWriteMethod(candidate.method) &&
    typeof candidate.moduleKey === 'string' &&
    typeof candidate.createdAt === 'string' &&
    candidate.createdAt.length > 0
  );
}

function generateOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `off-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildOfflineWriteOperation(params: {
  userId: string;
  companyId: string | null;
  path: string;
  method: OfflineWriteMethod;
  body: unknown;
  moduleKey: ModuleKey;
}): OfflineWriteOperation {
  return {
    id: generateOperationId(),
    userId: params.userId,
    companyId: params.companyId,
    path: params.path,
    method: params.method,
    body: params.body,
    moduleKey: params.moduleKey,
    createdAt: new Date().toISOString(),
  };
}

export function readOfflineWriteQueue(): OfflineWriteOperation[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isOfflineWriteOperation);
  } catch {
    return [];
  }
}

export function persistOfflineWriteQueue(queue: OfflineWriteOperation[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (queue.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore localStorage write errors and continue runtime flow.
  }
}
