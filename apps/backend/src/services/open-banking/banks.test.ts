import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPEN_BANKING_BANK_CODES, parseOpenBankingBankCode, providerNameForBankCode } from './banks.js';

test('OPEN_BANKING_BANK_CODES include băncile din planul v3.0', () => {
  assert.deepEqual(OPEN_BANKING_BANK_CODES, ['BCR', 'BRD', 'ING', 'RAIFFEISEN', 'UNICREDIT']);
});

test('parseOpenBankingBankCode normalizează corect input-ul', () => {
  assert.equal(parseOpenBankingBankCode(' bcr '), 'BCR');
  assert.equal(parseOpenBankingBankCode('ing'), 'ING');
  assert.equal(parseOpenBankingBankCode('UNicredit'), 'UNICREDIT');
  assert.equal(parseOpenBankingBankCode(''), null);
  assert.equal(parseOpenBankingBankCode('CEC'), null);
});

test('providerNameForBankCode returnează denumirea providerului implicit', () => {
  assert.equal(providerNameForBankCode('BCR'), 'BCR George Open Banking');
  assert.equal(providerNameForBankCode('BRD'), 'BRD Open Banking');
  assert.equal(providerNameForBankCode('ING'), 'ING Open Banking');
  assert.equal(providerNameForBankCode('RAIFFEISEN'), 'Raiffeisen Open Banking');
  assert.equal(providerNameForBankCode('UNICREDIT'), 'UniCredit Open Banking');
});
