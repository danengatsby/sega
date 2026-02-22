import { Prisma } from '@prisma/client';

export function toNumber(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  return Number(value.toString());
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
