import assert from 'node:assert/strict';
import test from 'node:test';
import { OMFP_ACCOUNTS, OMFP_ACCOUNTS_COUNT } from './omfp-chart.js';

test('planul OMFP seed include minimum 600 conturi', () => {
  assert.ok(
    OMFP_ACCOUNTS_COUNT >= 600,
    `Planul OMFP are ${OMFP_ACCOUNTS_COUNT} conturi, dar sunt necesare minimum 600.`,
  );
});

test('planul OMFP include conturile implicite folosite in postari automate', () => {
  const availableCodes = new Set(OMFP_ACCOUNTS.map((account) => account.code));
  const requiredCodes = ['281', '301', '401', '4111', '421', '4315', '4316', '4426', '4427', '444', '5121', '5311', '601', '641', '681', '707'];

  for (const code of requiredCodes) {
    assert.equal(availableCodes.has(code), true, `Lipseste contul obligatoriu ${code} din seed-ul OMFP.`);
  }
});

test('planul OMFP are coduri unice', () => {
  const seen = new Set<string>();
  for (const account of OMFP_ACCOUNTS) {
    assert.equal(seen.has(account.code), false, `Codul ${account.code} este duplicat in planul OMFP.`);
    seen.add(account.code);
  }
});

