import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'BankImport!Pass2026';

let server: Server | null = null;
let baseUrl = '';
let companyId: string | null = null;
let userId: string | null = null;
let userEmail = '';
let partnerId: string | null = null;
let invoiceId: string | null = null;
let invoiceNumber = '';

async function createIssuedInvoice(total: number, numberPrefix: string): Promise<{ id: string; number: string }> {
  assert.ok(companyId, 'Compania fixture lipsește');
  assert.ok(partnerId, 'Partener fixture lipsește');

  const number = `${numberPrefix}-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 60);
  const subtotal = Number((total / 1.19).toFixed(2));
  const vat = Number((total - subtotal).toFixed(2));

  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      number,
      kind: 'FISCAL',
      partnerId,
      issueDate: new Date('2026-02-21T10:00:00.000Z'),
      dueDate: new Date('2026-02-28T10:00:00.000Z'),
      currency: 'RON',
      subtotal,
      vat,
      total,
      status: 'ISSUED',
      description: `Fixture ${numberPrefix} pentru reconciliere extras`,
    },
  });

  return {
    id: invoice.id,
    number: invoice.number,
  };
}

function extractCookieHeader(response: Response): string {
  const rawCookies = response.headers.getSetCookie();
  return rawCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie && cookie.length > 0))
    .join('; ');
}

async function loginAndGetCookieHeader(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: userEmail,
      password: PASSWORD,
    }),
  });

  assert.equal(response.status, 200, `Autentificarea a eșuat cu status ${response.status}`);
  return extractCookieHeader(response);
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server?.on('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const company = await prisma.company.create({
    data: {
      code: `bank-file-${RUN_ID}`,
      name: `Bank File Import ${RUN_ID}`,
      isActive: true,
    },
  });
  companyId = company.id;

  userEmail = `bank-file-${RUN_ID}@sega.test`;
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email: userEmail,
      name: 'Bank File Import Accountant',
      passwordHash,
      role: Role.ACCOUNTANT,
      mustChangePassword: false,
      mfaEnabled: false,
    },
  });
  userId = user.id;

  await prisma.userCompanyMembership.create({
    data: {
      userId: user.id,
      companyId: company.id,
      role: Role.ACCOUNTANT,
      isDefault: true,
    },
  });

  await prisma.account.createMany({
    data: [
      {
        companyId: company.id,
        code: '5121',
        name: 'Conturi la bănci în lei',
        type: 'ASSET',
        currency: 'RON',
      },
      {
        companyId: company.id,
        code: '4111',
        name: 'Clienți',
        type: 'ASSET',
        currency: 'RON',
      },
    ],
  });

  const partner = await prisma.partner.create({
    data: {
      companyId: company.id,
      name: `Client import ${RUN_ID}`,
      type: 'CUSTOMER',
      iban: 'RO49AAAA1B31007593840000',
    },
  });
  partnerId = partner.id;

  const now = new Date('2026-02-21T10:00:00.000Z');
  const dueDate = new Date('2026-02-28T10:00:00.000Z');
  invoiceNumber = `INV-BANK-${RUN_ID}`;
  const invoice = await prisma.invoice.create({
    data: {
      companyId: company.id,
      number: invoiceNumber,
      kind: 'FISCAL',
      partnerId: partner.id,
      issueDate: now,
      dueDate,
      currency: 'RON',
      subtotal: 100,
      vat: 19,
      total: 119,
      status: 'ISSUED',
      description: 'Factură fixture pentru reconciliere extras',
    },
  });
  invoiceId = invoice.id;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  if (companyId) {
    await prisma.bankStatementLine.deleteMany({
      where: { companyId },
    });
    await prisma.bankStatement.deleteMany({
      where: { companyId },
    });
    await prisma.payment.deleteMany({
      where: { companyId },
    });
    await prisma.journalLine.deleteMany({
      where: {
        entry: {
          companyId,
        },
      },
    });
    await prisma.journalEntry.deleteMany({
      where: { companyId },
    });
    await prisma.invoice.deleteMany({
      where: { companyId },
    });
    await prisma.partner.deleteMany({
      where: { companyId },
    });
    await prisma.account.deleteMany({
      where: { companyId },
    });
    await prisma.accountingPeriod.deleteMany({
      where: { companyId },
    });
    await prisma.auditLog.deleteMany({
      where: { companyId },
    });
    await prisma.auditLog.updateMany({
      where: { companyId },
      data: { companyId: null },
    });
    await prisma.company.update({
      where: { id: companyId },
      data: {
        isActive: false,
      },
    });
  }

  if (userId) {
    await prisma.refreshSession.deleteMany({
      where: { userId },
    });
    await prisma.userCompanyMembership.deleteMany({
      where: { userId },
    });
    await prisma.auditLog.updateMany({
      where: { userId },
      data: { userId: null },
    });
    await prisma.user.delete({
      where: { id: userId },
    });
  }
});

test('import-file CSV + suggest + reconcile pentru factură client', async () => {
  assert.ok(invoiceId, 'Factura fixture lipsește');
  assert.ok(companyId, 'Compania fixture lipsește');
  assert.ok(partnerId, 'Partener fixture lipsește');

  const cookieHeader = await loginAndGetCookieHeader();
  const csvContent = [
    'date,amount,description,reference,counterpartyName,counterpartyIban',
    `2026-02-21,119.00,Incasare factura ${invoiceNumber},${invoiceNumber},CLIENT SRL,RO49AAAA1B31007593840000`,
  ].join('\n');

  const formData = new FormData();
  formData.append('accountCode', '5121');
  formData.append('format', 'CSV');
  formData.append('reason', 'integration-import-file');
  formData.append('file', new Blob([csvContent], { type: 'text/csv' }), 'statement.csv');

  const importStartedAt = Date.now();
  const importResponse = await fetch(`${baseUrl}/api/bank-reconciliation/statements/import-file`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
    },
    body: formData,
  });
  const importDurationMs = Date.now() - importStartedAt;
  if (importResponse.status !== 201) {
    const errorBody = await importResponse.text();
    assert.fail(`Import extras a eșuat (${importResponse.status}): ${errorBody}`);
  }
  assert.ok(importDurationMs < 15_000, `Importul a depășit SLA de 15s (${importDurationMs}ms).`);

  const importPayload = (await importResponse.json()) as {
    statement: { id: string };
    importSummary: { detectedFormat: string; linesImported: number };
  };

  assert.equal(importPayload.importSummary.detectedFormat, 'CSV');
  assert.equal(importPayload.importSummary.linesImported, 1);

  const statementLinesResponse = await fetch(
    `${baseUrl}/api/bank-reconciliation/statements/${importPayload.statement.id}/lines`,
    {
      headers: {
        cookie: cookieHeader,
      },
    },
  );
  assert.equal(statementLinesResponse.status, 200);
  const statementLines = (await statementLinesResponse.json()) as Array<{
    id: string;
    status: string;
    amount: string;
  }>;
  assert.equal(statementLines.length, 1);
  assert.equal(statementLines[0]?.status, 'UNMATCHED');
  assert.equal(Number(statementLines[0]?.amount ?? 0), 119);

  const statementLineId = statementLines[0]!.id;
  const suggestResponse = await fetch(`${baseUrl}/api/bank-reconciliation/lines/${statementLineId}/suggest?take=5`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(suggestResponse.status, 200);

  const suggestPayload = (await suggestResponse.json()) as {
    suggestions: Array<{
      targetType: string;
      targetId: string;
      score: number;
    }>;
  };

  const invoiceSuggestion = suggestPayload.suggestions.find((item) => item.targetType === 'INVOICE' && item.targetId === invoiceId);
  assert.ok(invoiceSuggestion, 'Sugestia automată pentru factura fixture lipsește.');
  assert.ok((invoiceSuggestion?.score ?? 0) > 0, 'Scor sugestie invalid pentru factura fixture.');

  const reconcileResponse = await fetch(`${baseUrl}/api/bank-reconciliation/lines/${statementLineId}/reconcile`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      targetType: 'INVOICE',
      targetId: invoiceId,
      method: 'BANK_TRANSFER',
      autoPost: true,
      bankAccountCode: '5121',
      receivableAccountCode: '4111',
      reason: 'integration-reconcile',
    }),
  });
  if (reconcileResponse.status !== 201) {
    const errorBody = await reconcileResponse.text();
    assert.fail(`Reconcilierea a eșuat (${reconcileResponse.status}): ${errorBody}`);
  }

  const reconcilePayload = (await reconcileResponse.json()) as {
    line: { status: string; matchedType: string; matchedRecordId: string };
    payment: { id: string; amount: string };
    invoice: { status: string };
  };

  assert.equal(reconcilePayload.line.status, 'MATCHED');
  assert.equal(reconcilePayload.line.matchedType, 'INVOICE');
  assert.equal(reconcilePayload.line.matchedRecordId, invoiceId);
  assert.equal(Number(reconcilePayload.payment.amount), 119);
  assert.equal(reconcilePayload.invoice.status, 'PAID');

  const [dbPayment, dbInvoice, dbJournalEntry] = await Promise.all([
    prisma.payment.findFirst({
      where: {
        companyId,
        invoiceId,
      },
    }),
    prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        status: true,
      },
    }),
    prisma.journalEntry.findFirst({
      where: {
        companyId,
        sourceModule: 'BANK_RECONCILIATION',
        description: {
          contains: invoiceNumber,
        },
      },
      include: {
        lines: true,
      },
    }),
  ]);

  assert.ok(dbPayment, 'Plata nu a fost persistată în baza de date.');
  assert.equal(Number(dbPayment?.amount ?? 0), 119);
  assert.equal(dbInvoice?.status, 'PAID');
  assert.ok(dbJournalEntry, 'Nota contabilă automată pentru reconciliere lipsește.');
  assert.equal(dbJournalEntry?.lines.length, 2, 'Nota contabilă de reconciliere trebuie să aibă 2 linii.');
});

test('import-file MT940 + suggest + reconcile pentru factură client', async () => {
  assert.ok(companyId, 'Compania fixture lipsește');

  const invoiceFixture = await createIssuedInvoice(238, 'INV-MT940');
  const cookieHeader = await loginAndGetCookieHeader();
  const mt940Content = [
    ':20:STARTUMSE',
    ':25:RO49AAAA1B31007593840000',
    ':28C:00001/001',
    ':60F:C260221RON500,00',
    `:61:2602210221C238,00NTRFNONREF//${invoiceFixture.number}`,
    `:86:/NAME/CLIENT MT940 SRL/IBAN/RO49AAAA1B31007593840000 Incasare ${invoiceFixture.number}`,
    ':62F:C260221RON738,00',
  ].join('\n');

  const formData = new FormData();
  formData.append('accountCode', '5121');
  formData.append('format', 'MT940');
  formData.append('reason', 'integration-import-file-mt940');
  formData.append('file', new Blob([mt940Content], { type: 'text/plain' }), 'statement.mt940');

  const importStartedAt = Date.now();
  const importResponse = await fetch(`${baseUrl}/api/bank-reconciliation/statements/import-file`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
    },
    body: formData,
  });
  const importDurationMs = Date.now() - importStartedAt;
  if (importResponse.status !== 201) {
    const errorBody = await importResponse.text();
    assert.fail(`Import MT940 a eșuat (${importResponse.status}): ${errorBody}`);
  }
  assert.ok(importDurationMs < 15_000, `Importul MT940 a depășit SLA de 15s (${importDurationMs}ms).`);

  const importPayload = (await importResponse.json()) as {
    statement: { id: string };
    importSummary: { detectedFormat: string; linesImported: number };
  };
  assert.equal(importPayload.importSummary.detectedFormat, 'MT940');
  assert.equal(importPayload.importSummary.linesImported, 1);

  const statementLinesResponse = await fetch(
    `${baseUrl}/api/bank-reconciliation/statements/${importPayload.statement.id}/lines`,
    {
      headers: {
        cookie: cookieHeader,
      },
    },
  );
  assert.equal(statementLinesResponse.status, 200);
  const statementLines = (await statementLinesResponse.json()) as Array<{
    id: string;
    status: string;
    amount: string;
    reference?: string;
  }>;
  assert.equal(statementLines.length, 1);
  assert.equal(statementLines[0]?.status, 'UNMATCHED');
  assert.equal(Number(statementLines[0]?.amount ?? 0), 238);

  const statementLineId = statementLines[0]!.id;
  const suggestResponse = await fetch(`${baseUrl}/api/bank-reconciliation/lines/${statementLineId}/suggest?take=5`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(suggestResponse.status, 200);

  const suggestPayload = (await suggestResponse.json()) as {
    suggestions: Array<{
      targetType: string;
      targetId: string;
      score: number;
    }>;
  };
  const invoiceSuggestion = suggestPayload.suggestions.find(
    (item) => item.targetType === 'INVOICE' && item.targetId === invoiceFixture.id,
  );
  assert.ok(invoiceSuggestion, 'Sugestia automată pentru factura MT940 lipsește.');

  const reconcileResponse = await fetch(`${baseUrl}/api/bank-reconciliation/lines/${statementLineId}/reconcile`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      targetType: 'INVOICE',
      targetId: invoiceFixture.id,
      method: 'BANK_TRANSFER',
      autoPost: true,
      bankAccountCode: '5121',
      receivableAccountCode: '4111',
      reason: 'integration-reconcile-mt940',
    }),
  });
  if (reconcileResponse.status !== 201) {
    const errorBody = await reconcileResponse.text();
    assert.fail(`Reconcilierea MT940 a eșuat (${reconcileResponse.status}): ${errorBody}`);
  }

  const reconcilePayload = (await reconcileResponse.json()) as {
    payment: { id: string; amount: string };
    invoice: { status: string };
  };
  assert.equal(reconcilePayload.invoice.status, 'PAID');
  assert.equal(Number(reconcilePayload.payment.amount), 238);

  const dbPayment = await prisma.payment.findUnique({
    where: {
      id: reconcilePayload.payment.id,
    },
  });

  assert.ok(dbPayment, 'Plata MT940 nu a fost persistată în baza de date.');
  assert.equal(Number(dbPayment?.amount ?? 0), 238);
});

test('import-file CAMT.053 + suggest + reconcile pentru factură client', async () => {
  assert.ok(companyId, 'Compania fixture lipsește');

  const invoiceFixture = await createIssuedInvoice(357, 'INV-CAMT053');
  const cookieHeader = await loginAndGetCookieHeader();
  const camtContent = `
<?xml version="1.0" encoding="UTF-8"?>
<Document>
  <BkToCstmrStmt>
    <Stmt>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="RON">1200.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="RON">1557.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
      </Bal>
      <Ntry>
        <Amt Ccy="RON">357.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-02-21</Dt></BookgDt>
        <NtryRef>${invoiceFixture.number}</NtryRef>
        <AddtlNtryInf>Incasare factura ${invoiceFixture.number}</AddtlNtryInf>
        <NtryDtls>
          <TxDtls>
            <RltdPties>
              <Dbtr><Nm>CLIENT CAMT SRL</Nm></Dbtr>
              <DbtrAcct><Id><IBAN>RO49AAAA1B31007593840000</IBAN></Id></DbtrAcct>
            </RltdPties>
            <Refs>
              <EndToEndId>${invoiceFixture.number}</EndToEndId>
            </Refs>
            <RmtInf>
              <Ustrd>Plata factura ${invoiceFixture.number}</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>
`.trim();

  const formData = new FormData();
  formData.append('accountCode', '5121');
  formData.append('format', 'CAMT053');
  formData.append('reason', 'integration-import-file-camt053');
  formData.append('file', new Blob([camtContent], { type: 'application/xml' }), 'statement.xml');

  const importStartedAt = Date.now();
  const importResponse = await fetch(`${baseUrl}/api/bank-reconciliation/statements/import-file`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
    },
    body: formData,
  });
  const importDurationMs = Date.now() - importStartedAt;
  if (importResponse.status !== 201) {
    const errorBody = await importResponse.text();
    assert.fail(`Import CAMT.053 a eșuat (${importResponse.status}): ${errorBody}`);
  }
  assert.ok(importDurationMs < 15_000, `Importul CAMT.053 a depășit SLA de 15s (${importDurationMs}ms).`);

  const importPayload = (await importResponse.json()) as {
    statement: { id: string };
    importSummary: { detectedFormat: string; linesImported: number };
  };
  assert.equal(importPayload.importSummary.detectedFormat, 'CAMT053');
  assert.equal(importPayload.importSummary.linesImported, 1);

  const statementLinesResponse = await fetch(
    `${baseUrl}/api/bank-reconciliation/statements/${importPayload.statement.id}/lines`,
    {
      headers: {
        cookie: cookieHeader,
      },
    },
  );
  assert.equal(statementLinesResponse.status, 200);
  const statementLines = (await statementLinesResponse.json()) as Array<{
    id: string;
    status: string;
    amount: string;
  }>;
  assert.equal(statementLines.length, 1);
  assert.equal(statementLines[0]?.status, 'UNMATCHED');
  assert.equal(Number(statementLines[0]?.amount ?? 0), 357);

  const statementLineId = statementLines[0]!.id;
  const suggestResponse = await fetch(`${baseUrl}/api/bank-reconciliation/lines/${statementLineId}/suggest?take=5`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(suggestResponse.status, 200);

  const suggestPayload = (await suggestResponse.json()) as {
    suggestions: Array<{
      targetType: string;
      targetId: string;
      score: number;
    }>;
  };
  const invoiceSuggestion = suggestPayload.suggestions.find(
    (item) => item.targetType === 'INVOICE' && item.targetId === invoiceFixture.id,
  );
  assert.ok(invoiceSuggestion, 'Sugestia automată pentru factura CAMT.053 lipsește.');

  const reconcileResponse = await fetch(`${baseUrl}/api/bank-reconciliation/lines/${statementLineId}/reconcile`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      targetType: 'INVOICE',
      targetId: invoiceFixture.id,
      method: 'BANK_TRANSFER',
      autoPost: true,
      bankAccountCode: '5121',
      receivableAccountCode: '4111',
      reason: 'integration-reconcile-camt053',
    }),
  });
  if (reconcileResponse.status !== 201) {
    const errorBody = await reconcileResponse.text();
    assert.fail(`Reconcilierea CAMT.053 a eșuat (${reconcileResponse.status}): ${errorBody}`);
  }

  const reconcilePayload = (await reconcileResponse.json()) as {
    payment: { id: string; amount: string };
    invoice: { status: string };
  };
  assert.equal(reconcilePayload.invoice.status, 'PAID');
  assert.equal(Number(reconcilePayload.payment.amount), 357);

  const [dbPayment, dbInvoice] = await Promise.all([
    prisma.payment.findUnique({
      where: {
        id: reconcilePayload.payment.id,
      },
    }),
    prisma.invoice.findUnique({
      where: { id: invoiceFixture.id },
      select: {
        status: true,
      },
    }),
  ]);

  assert.ok(dbPayment, 'Plata CAMT.053 nu a fost persistată în baza de date.');
  assert.equal(Number(dbPayment?.amount ?? 0), 357);
  assert.equal(dbInvoice?.status, 'PAID');
});
