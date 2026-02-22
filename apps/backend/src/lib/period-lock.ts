import type { Prisma } from '@prisma/client';
import { PeriodStatus } from '@prisma/client';
import { HttpError } from './http-error.js';
import { prisma } from './prisma.js';

type PeriodLockDbClient = Pick<Prisma.TransactionClient, 'accountingPeriod'>;

export async function assertPeriodOpen(
  companyId: string,
  period: string,
  db: PeriodLockDbClient = prisma,
): Promise<void> {
  const lockedPeriod = await db.accountingPeriod.findUnique({
    where: {
      companyId_period: {
        companyId,
        period,
      },
    },
    select: {
      status: true,
    },
  });

  if (lockedPeriod?.status === PeriodStatus.CLOSED) {
    throw HttpError.conflict(`Perioada ${period} este închisă. Operațiunea este blocată.`);
  }
}

