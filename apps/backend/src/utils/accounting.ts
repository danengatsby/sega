import { round2 } from './number.js';
import { HttpError } from '../lib/http-error.js';

export function validateDoubleEntry(lines: Array<{ debit: number; credit: number }>): { ok: true } {
  if (lines.length < 2) {
    throw HttpError.badRequest('O notă contabilă trebuie să aibă minim 2 linii.');
  }

  const invalidLine = lines.some((line) => line.debit < 0 || line.credit < 0 || (line.debit === 0 && line.credit === 0));
  if (invalidLine) {
    throw HttpError.badRequest('Fiecare linie trebuie să conțină debit sau credit pozitiv.');
  }

  const debitTotal = round2(lines.reduce((sum, line) => sum + line.debit, 0));
  const creditTotal = round2(lines.reduce((sum, line) => sum + line.credit, 0));

  if (debitTotal <= 0 || creditTotal <= 0) {
    throw HttpError.badRequest('Totalul debit/credit trebuie să fie > 0.');
  }

  if (debitTotal !== creditTotal) {
    throw HttpError.badRequest(`Nota nu este echilibrată. Debit=${debitTotal}, Credit=${creditTotal}`);
  }

  return { ok: true };
}

export function currentPeriod(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}
