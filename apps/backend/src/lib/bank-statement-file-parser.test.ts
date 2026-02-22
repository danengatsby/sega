import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBankStatementFile } from './bank-statement-file-parser.js';

const validClientIban = 'RO49AAAA1B31007593840000';
const validSupplierIban = 'RO09BCYP0000001234567890';

test('parseBankStatementFile parsează MT940', () => {
  const mt940 = `
:20:STARTUMSE
:25:${validClientIban}
:28C:00001/001
:60F:C260221RON1000,00
:61:2602210221C250,00NTRFNONREF//RF1001
:86:/NAME/CLIENT SRL/IBAN/${validClientIban} Incasare factura 1001
:61:2602210221D100,00NTRFNONREF//RF1002
:86:/NAME/FURNIZOR SRL/IBAN/${validSupplierIban} Plata furnizor
:62F:C260221RON1150,00
`.trim();

  const parsed = parseBankStatementFile({
    fileName: 'statement.mt940',
    content: mt940,
  });

  assert.equal(parsed.detectedFormat, 'MT940');
  assert.equal(parsed.currency, 'RON');
  assert.equal(parsed.openingBalance, 1000);
  assert.equal(parsed.closingBalance, 1150);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0]?.amount, 250);
  assert.equal(parsed.lines[1]?.amount, -100);
});

test('parseBankStatementFile parsează CAMT.053', () => {
  const camt = `
<?xml version="1.0" encoding="UTF-8"?>
<Document>
  <BkToCstmrStmt>
    <Stmt>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="RON">1000.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="RON">1150.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
      </Bal>
      <Ntry>
        <Amt Ccy="RON">250.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-02-21</Dt></BookgDt>
        <NtryRef>RF1001</NtryRef>
        <AddtlNtryInf>Incasare factura</AddtlNtryInf>
        <NtryDtls>
          <TxDtls>
            <RltdPties>
              <Dbtr><Nm>CLIENT SRL</Nm></Dbtr>
              <DbtrAcct><Id><IBAN>${validClientIban}</IBAN></Id></DbtrAcct>
            </RltdPties>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="RON">100.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-02-21</Dt></BookgDt>
        <NtryRef>RF1002</NtryRef>
        <AddtlNtryInf>Plata furnizor</AddtlNtryInf>
        <NtryDtls>
          <TxDtls>
            <RltdPties>
              <Cdtr><Nm>FURNIZOR SRL</Nm></Cdtr>
              <CdtrAcct><Id><IBAN>${validSupplierIban}</IBAN></Id></CdtrAcct>
            </RltdPties>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>
`.trim();

  const parsed = parseBankStatementFile({
    fileName: 'statement.xml',
    content: camt,
  });

  assert.equal(parsed.detectedFormat, 'CAMT053');
  assert.equal(parsed.currency, 'RON');
  assert.equal(parsed.openingBalance, 1000);
  assert.equal(parsed.closingBalance, 1150);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0]?.amount, 250);
  assert.equal(parsed.lines[1]?.amount, -100);
});

test('parseBankStatementFile parsează CSV cu delimiter detectat automat', () => {
  const csv = `
date;amount;description;reference;counterpartyName;counterpartyIban
2026-02-21;250.00;Incasare factura;RF1001;CLIENT SRL;${validClientIban}
2026-02-21;-100,00;Plata furnizor;RF1002;FURNIZOR SRL;${validSupplierIban}
`.trim();

  const parsed = parseBankStatementFile({
    fileName: 'statement.csv',
    content: csv,
  });

  assert.equal(parsed.detectedFormat, 'CSV');
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0]?.amount, 250);
  assert.equal(parsed.lines[1]?.amount, -100);
});

test('parseBankStatementFile validează maparea CSV obligatorie', () => {
  const csv = `
bookingDate;description
2026-02-21;Fara suma
`.trim();

  assert.throws(
    () =>
      parseBankStatementFile({
        fileName: 'invalid.csv',
        content: csv,
      }),
    /coloanele obligatorii date și amount lipsesc/i,
  );
});

test('parseBankStatementFile procesează 500 tranzacții sub prag operațional', () => {
  const rows: string[] = ['date,amount,description,reference,counterpartyName,counterpartyIban'];
  for (let index = 0; index < 500; index += 1) {
    rows.push(`2026-02-21,${index % 2 === 0 ? '10.50' : '-7.25'},Row ${index},RF${index},PARTNER,${validClientIban}`);
  }

  const payload = rows.join('\n');
  const start = Date.now();
  const parsed = parseBankStatementFile({
    fileName: 'bulk.csv',
    content: payload,
    format: 'CSV',
  });
  const durationMs = Date.now() - start;

  assert.equal(parsed.lines.length, 500);
  assert.ok(durationMs < 15_000, `Parsarea a depășit pragul operațional de 15s (${durationMs}ms).`);
});
