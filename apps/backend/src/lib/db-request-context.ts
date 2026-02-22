import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

const requestTransactionStorage = new AsyncLocalStorage<Prisma.TransactionClient>();

export function runWithRequestTransaction<T>(tx: Prisma.TransactionClient, callback: () => T): T {
  return requestTransactionStorage.run(tx, callback);
}

export function getRequestTransaction(): Prisma.TransactionClient | null {
  return requestTransactionStorage.getStore() ?? null;
}
