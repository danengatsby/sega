import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  annualRange,
  parseDecimalQuery,
  parseFinancialYear,
  parseIntegerQuery,
  resolveAnafValidateRequested,
} from './helpers.js';

test('resolveAnafValidateRequested păstrează validate=true când strict=false', () => {
  assert.equal(resolveAnafValidateRequested(false, true), true);
});

test('resolveAnafValidateRequested păstrează validate=false când strict=false', () => {
  assert.equal(resolveAnafValidateRequested(false, false), false);
});

test('resolveAnafValidateRequested forțează validate=true când strict=true', () => {
  assert.equal(resolveAnafValidateRequested(true, false), true);
});

test('parseFinancialYear acceptă YYYY valid', () => {
  assert.equal(parseFinancialYear('2026'), 2026);
});

test('parseFinancialYear respinge input invalid', () => {
  assert.throws(() => parseFinancialYear('2026-01'), /format YYYY/);
});

test('annualRange construiește capetele UTC ale anului', () => {
  const range = annualRange(2026);
  assert.equal(range.from?.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(range.to?.toISOString(), '2026-12-31T23:59:59.999Z');
});

test('parseIntegerQuery aplică fallback când parametrul nu este furnizat', () => {
  assert.equal(parseIntegerQuery(undefined, 'maxAlerts', 20, 1, 100), 20);
});

test('parseIntegerQuery validează intervalul și tipul', () => {
  assert.equal(parseIntegerQuery('30', 'dueSoonDays', 7, 1, 90), 30);
  assert.throws(() => parseIntegerQuery('1.2', 'dueSoonDays', 7, 1, 90), /număr întreg/);
  assert.throws(() => parseIntegerQuery('120', 'dueSoonDays', 7, 1, 90), /intervalul 1-90/);
});

test('parseDecimalQuery validează intervalul numeric', () => {
  assert.equal(parseDecimalQuery('1500.55', 'minAmount', 0, 0, 1_000_000_000), 1500.55);
  assert.throws(() => parseDecimalQuery('abc', 'minAmount', 0, 0, 1_000_000_000), /număr valid/);
  assert.throws(() => parseDecimalQuery('-1', 'minAmount', 0, 0, 1_000_000_000), /intervalul 0-1000000000/);
});
