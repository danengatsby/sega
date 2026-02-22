import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FinancialStatementBundle } from './types.js';
import { buildXbrlContent, validateXbrlWithSchema } from './xbrl-export-service.js';

const SAMPLE_BUNDLE: FinancialStatementBundle = {
  meta: {
    generatedAt: '2026-02-22T00:00:00.000Z',
    from: '2025-01-01T00:00:00.000Z',
    to: '2025-12-31T23:59:59.999Z',
  },
  trialBalance: {
    rows: [],
    totals: {
      debit: 12450.5,
      credit: 12450.5,
    },
  },
  pnl: {
    revenues: 50000,
    expenses: 42000,
    netProfit: 8000,
  },
  balanceSheet: {
    assets: 82000,
    liabilities: 30000,
    equity: 52000,
    liabilitiesAndEquity: 82000,
  },
  aging: {
    buckets: {
      current: 0,
      d1_30: 0,
      d31_60: 0,
      d61_90: 0,
      d90_plus: 0,
    },
    rows: [],
  },
  taxSummary: {
    taxableSales: 42000,
    vatCollected: 7980,
    payrollCas: 6000,
    payrollCass: 2400,
    payrollCam: 540,
    payrollTax: 1600,
    estimatedProfitTax: 1280,
    totalFiscalLiabilities: 19800,
  },
};

test('buildXbrlContent produce instanță XBRL anuală cu facts monetare', () => {
  const xml = buildXbrlContent(SAMPLE_BUNDLE, {
    year: 2025,
    entityIdentifier: 'company-1',
  });

  assert.match(xml, /<xbrli:xbrl[\s\S]*<\/xbrli:xbrl>/);
  assert.match(xml, /<xbrli:context id="CTX-2025">/);
  assert.match(xml, /<xbrli:identifier scheme="urn:sega:company-id">company-1<\/xbrli:identifier>/);
  assert.match(xml, /<sega:Assets contextRef="CTX-2025" unitRef="U-RON" decimals="2">82000\.00<\/sega:Assets>/);
  assert.match(xml, /<sega:TotalFiscalLiabilities contextRef="CTX-2025" unitRef="U-RON" decimals="2">19800\.00<\/sega:TotalFiscalLiabilities>/);
});

test('validateXbrlWithSchema permite skip explicit de validare', async () => {
  const xml = buildXbrlContent(SAMPLE_BUNDLE, {
    year: 2025,
    entityIdentifier: 'company-1',
  });

  const validation = await validateXbrlWithSchema(xml, false);
  assert.equal(validation.performed, false);
  assert.equal(validation.valid, null);
});

test('validateXbrlWithSchema validează pe schema țintă când validatorul local este disponibil', async () => {
  const xml = buildXbrlContent(SAMPLE_BUNDLE, {
    year: 2025,
    entityIdentifier: 'company-1',
  });

  const validation = await validateXbrlWithSchema(xml, true);

  if (validation.performed) {
    assert.equal(validation.valid, true, `XBRL invalid: ${validation.errors.join(' | ')}`);
    return;
  }

  assert.equal(validation.valid, null);
  assert.ok(validation.warnings.length > 0);
});
