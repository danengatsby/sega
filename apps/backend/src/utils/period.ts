import { HttpError } from '../lib/http-error.js';

export function parsePeriod(period: string): { year: number; month: number } {
  const match = period.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw HttpError.badRequest('Perioada trebuie să fie în format YYYY-MM.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (month < 1 || month > 12) {
    throw HttpError.badRequest('Luna din perioadă este invalidă.');
  }

  return { year, month };
}

export function periodToDateRange(period: string): { start: Date; end: Date } {
  const { year, month } = parsePeriod(period);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start, end };
}

export function monthDiffUTC(start: Date, end: Date): number {
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  const startMonth = start.getUTCMonth();
  const endMonth = end.getUTCMonth();

  return (endYear - startYear) * 12 + (endMonth - startMonth);
}
