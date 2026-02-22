import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { env } from '../config/env.js';
import { buildEfacturaInvoiceXml, submitEfacturaEndToEnd } from './efactura/anaf-efactura-service.js';

const originalMode = env.ANAF_EFACTURA_MODE;

afterEach(() => {
  env.ANAF_EFACTURA_MODE = originalMode;
});

test('buildEfacturaInvoiceXml generează un UBL minim valid pentru CUI furnizor/client', () => {
  const xml = buildEfacturaInvoiceXml(
    {
      invoiceId: 'inv-test',
      number: 'INV-2026-0001',
      issueDate: new Date('2026-02-01T10:00:00.000Z'),
      dueDate: new Date('2026-02-15T10:00:00.000Z'),
      currency: 'RON',
      subtotal: 1000,
      vat: 190,
      total: 1190,
      description: 'Servicii consultanta',
    },
    {
      companyId: 'cmp-test',
      name: 'Furnizor Test SRL',
      cui: 'RO12345678',
      address: 'Bucuresti',
      iban: 'RO49AAAA1B31007593840000',
    },
    {
      name: 'Client Test SRL',
      cui: 'RO87654321',
      address: 'Cluj-Napoca',
      iban: 'RO49BBBB1B31007593840000',
    },
  );

  assert.match(xml, /<cbc:ID>INV-2026-0001<\/cbc:ID>/);
  assert.match(xml, /<cbc:EndpointID schemeID="RO:CUI">RO12345678<\/cbc:EndpointID>/);
  assert.match(xml, /<cbc:EndpointID schemeID="RO:CUI">RO87654321<\/cbc:EndpointID>/);
  assert.match(xml, /<cbc:TaxInclusiveAmount currencyID="RON">1190\.00<\/cbc:TaxInclusiveAmount>/);
});

test('submitEfacturaEndToEnd in modul mock executa upload, poll si download XML semnat', async () => {
  env.ANAF_EFACTURA_MODE = 'mock';

  const result = await submitEfacturaEndToEnd({
    xml: '<?xml version="1.0" encoding="UTF-8"?><Invoice/>',
    waitForSignedXml: true,
  });

  assert.equal(result.status, 'ACCEPTED');
  assert.equal(result.polls, 1);
  assert.ok(result.uploadIndex.startsWith('mock-upload-'));
  assert.ok(result.downloadId?.startsWith('mock-download-'));
  assert.ok(result.signedXml?.includes('<SignedInvoice'));
});
