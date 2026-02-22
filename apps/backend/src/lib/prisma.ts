import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { getRequestTransaction } from './db-request-context.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = basePrisma;
}

export const rootPrisma = basePrisma;

function runTransactionWithinRequestContext(
  tx: Prisma.TransactionClient,
  args: unknown[],
): Promise<unknown> {
  const [firstArg] = args;
  if (typeof firstArg === 'function') {
    return Promise.resolve((firstArg as (client: Prisma.TransactionClient) => unknown)(tx));
  }

  throw new Error('Nested prisma.$transaction([...]) nu este suportat în contextul request-scoped.');
}

export const prisma = new Proxy(basePrisma, {
  get(target, prop, receiver) {
    if (prop === '$transaction') {
      const activeTransaction = getRequestTransaction();
      if (activeTransaction) {
        return (...args: unknown[]) => runTransactionWithinRequestContext(activeTransaction, args);
      }
      return target.$transaction.bind(target);
    }

    const activeTransaction = getRequestTransaction();
    const source = activeTransaction ?? target;
    const value = Reflect.get(source as object, prop, receiver);

    if (typeof value === 'function') {
      return value.bind(source);
    }

    return value;
  },
}) as PrismaClient;
