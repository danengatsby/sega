import type { Request, Response } from 'express';
import { HttpError } from '../../lib/http-error.js';
import type { AnafPeriod, AnafValidationSummary, DateRange } from './types.js';

export function parseDateInput(value: unknown, fieldName: string): Date | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw HttpError.badRequest(`Parametrul ${fieldName} este invalid.`);
  }

  return parsed;
}

export function parseRange(req: Request): DateRange {
  return {
    from: parseDateInput(req.query.from, 'from'),
    to: parseDateInput(req.query.to, 'to'),
  };
}

export function parseAnafPeriod(value: unknown): AnafPeriod {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})$/);

  if (!match) {
    throw HttpError.badRequest('Parametrul period este obligatoriu și trebuie să fie în format YYYY-MM.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (month < 1 || month > 12) {
    throw HttpError.badRequest('Luna din parametrul period este invalidă.');
  }

  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  return { period: raw, start, end };
}

export function parseFinancialYear(value: unknown): number {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}$/.test(raw)) {
    throw HttpError.badRequest('Parametrul year este obligatoriu și trebuie să fie în format YYYY.');
  }

  const year = Number(raw);
  if (year < 1900 || year > 2999) {
    throw HttpError.badRequest('Parametrul year este în afara intervalului permis (1900-2999).');
  }

  return year;
}

export function annualRange(year: number): DateRange {
  return {
    from: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
    to: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
  };
}

export function hasRange(range: DateRange): boolean {
  return Boolean(range.from || range.to);
}

export function parseBooleanQuery(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n'].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function parseIntegerQuery(
  value: unknown,
  fieldName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw HttpError.badRequest(`Parametrul ${fieldName} trebuie să fie un număr întreg.`);
  }

  if (parsed < min || parsed > max) {
    throw HttpError.badRequest(`Parametrul ${fieldName} trebuie să fie în intervalul ${min}-${max}.`);
  }

  return parsed;
}

export function parseDecimalQuery(
  value: unknown,
  fieldName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw HttpError.badRequest(`Parametrul ${fieldName} trebuie să fie un număr valid.`);
  }

  if (parsed < min || parsed > max) {
    throw HttpError.badRequest(`Parametrul ${fieldName} trebuie să fie în intervalul ${min}-${max}.`);
  }

  return parsed;
}

export function resolveAnafValidateRequested(strict: boolean, validateRequested: boolean): boolean {
  return strict || validateRequested;
}

export function csvCell(value: string | number): string {
  const raw = String(value);
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function formatAmount(value: number): string {
  return value.toFixed(2);
}

export function setAnafValidationHeaders(res: Response, validation: AnafValidationSummary): void {
  res.setHeader('X-Anaf-Declaration', validation.declaration);
  res.setHeader('X-Anaf-Period', validation.period);
  res.setHeader('X-Anaf-Profile-Valid', validation.profile.valid ? 'true' : 'false');
  res.setHeader('X-Anaf-Xsd-Performed', validation.xsd.performed ? 'true' : 'false');
  res.setHeader('X-Anaf-Xsd-Valid', validation.xsd.valid === null ? 'unknown' : validation.xsd.valid ? 'true' : 'false');
}
