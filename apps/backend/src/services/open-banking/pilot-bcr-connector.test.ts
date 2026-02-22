import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __internal } from './pilot-bcr-connector.js';

test('parseAccountsPayload mapează conturile și soldurile din payload', () => {
  const payload = {
    data: {
      accounts: [
        {
          id: 'acc-1',
          iban: 'RO49AAAA1B31007593840000',
          currency: 'RON',
          balance: {
            amount: '1500.45',
          },
          name: 'Cont curent RON',
        },
      ],
    },
  };

  const accounts = __internal.parseAccountsPayload(payload);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.externalAccountId, 'acc-1');
  assert.equal(accounts[0]?.currency, 'RON');
  assert.equal(accounts[0]?.balance, 1500.45);
  assert.equal(accounts[0]?.iban, 'RO49AAAA1B31007593840000');
});

test('parseTransactionsPayload mapează credit/debit și ordonează după bookingDate', () => {
  const payload = {
    transactions: [
      {
        transactionId: 'tx-2',
        bookingDate: '2026-02-22T08:00:00.000Z',
        amount: {
          amount: '50.00',
          currency: 'RON',
        },
        creditDebitIndicator: 'DBIT',
        description: 'Plată furnizor',
      },
      {
        transactionId: 'tx-1',
        bookingDate: '2026-02-21T08:00:00.000Z',
        amount: {
          amount: '120.00',
          currency: 'RON',
        },
        creditDebitIndicator: 'CRDT',
        description: 'Încasare client',
      },
    ],
  };

  const transactions = __internal.parseTransactionsPayload(payload);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0]?.externalTransactionId, 'tx-1');
  assert.equal(transactions[0]?.amount, 120);
  assert.equal(transactions[1]?.externalTransactionId, 'tx-2');
  assert.equal(transactions[1]?.amount, -50);
});
