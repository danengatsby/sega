import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveD300VatAmounts } from './anaf-service.js';

test('resolveD300VatAmounts folosește jurnalul TVA când există rulaje 4426/4427', () => {
  const summary = resolveD300VatAmounts({
    invoiceVatCollected: 1500,
    supplierVatDeductible: 900,
    journalCollected: 1600,
    journalDeductible: 1000,
  });

  assert.equal(summary.vatCollected, 1600);
  assert.equal(summary.vatDeductible, 1000);
  assert.equal(summary.vatBalance, 600);
});

test('resolveD300VatAmounts cade pe facturi când jurnalul TVA lipsește', () => {
  const summary = resolveD300VatAmounts({
    invoiceVatCollected: 1500,
    supplierVatDeductible: 900,
    journalCollected: null,
    journalDeductible: null,
  });

  assert.equal(summary.vatCollected, 1500);
  assert.equal(summary.vatDeductible, 900);
  assert.equal(summary.vatBalance, 600);
});

