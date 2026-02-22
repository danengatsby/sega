import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { buildD406ConformityReport, buildD406Xml, validateAnafPayload } from './anaf-service.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let companyId: string | null = null;
let userId: string | null = null;
let invoiceNumber = '';
let supplierInvoiceNumber = '';

before(async () => {
  const company = await prisma.company.create({
    data: {
      code: `d406-${RUN_ID}`,
      name: `D406 SAF-T ${RUN_ID}`,
      isActive: true,
    },
  });
  companyId = company.id;

  const user = await prisma.user.create({
    data: {
      email: `d406-${RUN_ID}@sega.test`,
      name: 'D406 SAF-T Test',
      passwordHash: 'test-password-hash',
      mustChangePassword: false,
      role: Role.ADMIN,
      mfaEnabled: false,
    },
  });
  userId = user.id;

  const [account4111, account701, account4427, account401] = await Promise.all([
    prisma.account.create({
      data: {
        companyId: company.id,
        code: '4111',
        name: 'Clienți',
        type: 'ASSET',
        currency: 'RON',
      },
    }),
    prisma.account.create({
      data: {
        companyId: company.id,
        code: '701',
        name: 'Venituri din vânzarea produselor finite',
        type: 'REVENUE',
        currency: 'RON',
      },
    }),
    prisma.account.create({
      data: {
        companyId: company.id,
        code: '4427',
        name: 'TVA colectată',
        type: 'LIABILITY',
        currency: 'RON',
      },
    }),
    prisma.account.create({
      data: {
        companyId: company.id,
        code: '401',
        name: 'Furnizori',
        type: 'LIABILITY',
        currency: 'RON',
      },
    }),
  ]);

  const customer = await prisma.partner.create({
    data: {
      companyId: company.id,
      name: `Customer D406 ${RUN_ID}`,
      type: 'CUSTOMER',
      cui: 'RO12345678',
      iban: 'RO49AAAA1B31007593840000',
    },
  });

  const supplier = await prisma.partner.create({
    data: {
      companyId: company.id,
      name: `Supplier D406 ${RUN_ID}`,
      type: 'SUPPLIER',
      cui: 'RO87654321',
      iban: 'RO09AAAA1B31007593840001',
    },
  });

  await prisma.stockItem.create({
    data: {
      companyId: company.id,
      code: `STK-${RUN_ID.slice(-5)}`,
      name: 'Produs SAF-T',
      unit: 'BUC',
      valuationMethod: 'FIFO',
      minStockQty: 0,
      quantityOnHand: 10,
      avgUnitCost: 25,
      isActive: true,
    },
  });

  await prisma.asset.create({
    data: {
      companyId: company.id,
      code: `MF-${RUN_ID.slice(-5)}`,
      name: 'Laptop contabilitate',
      value: 5500,
      residualValue: 500,
      depreciationMethod: 'LINEAR',
      startDate: new Date('2026-02-01T00:00:00.000Z'),
      usefulLifeMonths: 36,
      isActive: true,
    },
  });

  await prisma.journalEntry.create({
    data: {
      companyId: company.id,
      number: `NC-2026-${RUN_ID.slice(-6)}`,
      date: new Date('2026-02-15T10:00:00.000Z'),
      description: 'Înregistrare factură client',
      period: '2026-02',
      status: 'VALIDATED',
      posted: true,
      createdById: user.id,
      lines: {
        create: [
          {
            accountId: account4111.id,
            debit: 119,
            credit: 0,
            explanation: 'Creanță client',
          },
          {
            accountId: account701.id,
            debit: 0,
            credit: 100,
            explanation: 'Venituri',
          },
          {
            accountId: account4427.id,
            debit: 0,
            credit: 19,
            explanation: 'TVA colectată',
          },
        ],
      },
    },
  });

  invoiceNumber = `INV-D406-${RUN_ID.slice(-6)}`;
  await prisma.invoice.create({
    data: {
      companyId: company.id,
      number: invoiceNumber,
      kind: 'FISCAL',
      partnerId: customer.id,
      issueDate: new Date('2026-02-16T00:00:00.000Z'),
      dueDate: new Date('2026-03-16T00:00:00.000Z'),
      currency: 'RON',
      subtotal: 100,
      vat: 19,
      total: 119,
      status: 'ISSUED',
      description: 'Factură client pentru test D406',
    },
  });

  supplierInvoiceNumber = `FURN-D406-${RUN_ID.slice(-6)}`;
  await prisma.supplierInvoice.create({
    data: {
      companyId: company.id,
      number: supplierInvoiceNumber,
      supplierId: supplier.id,
      receivedDate: new Date('2026-02-14T00:00:00.000Z'),
      dueDate: new Date('2026-03-14T00:00:00.000Z'),
      currency: 'RON',
      subtotal: 200,
      vat: 38,
      total: 238,
      status: 'RECEIVED',
      approvalStatus: 'PENDING_LEVEL_1',
      approvalCurrentLevel: 1,
      approvalRequiredLevel: 3,
      description: 'Factură furnizor pentru test D406',
    },
  });

  void account401;
});

after(async () => {
  if (companyId) {
    await prisma.auditLog.deleteMany({
      where: { companyId },
    });
    await prisma.openBankingSyncRun.deleteMany({
      where: { companyId },
    });
    await prisma.openBankingConnection.deleteMany({
      where: { companyId },
    });
    await prisma.bankStatementLine.deleteMany({
      where: { companyId },
    });
    await prisma.bankStatement.deleteMany({
      where: { companyId },
    });
    await prisma.payment.deleteMany({
      where: { companyId },
    });
    await prisma.supplierPayment.deleteMany({
      where: { companyId },
    });
    await prisma.supplierInvoiceApproval.deleteMany({
      where: { companyId },
    });
    await prisma.supplierInvoice.deleteMany({
      where: { companyId },
    });
    await prisma.invoice.deleteMany({
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
    await prisma.assetDepreciation.deleteMany({
      where: {
        asset: {
          companyId,
        },
      },
    });
    await prisma.asset.deleteMany({
      where: { companyId },
    });
    await prisma.stockLot.deleteMany({
      where: { companyId },
    });
    await prisma.stockMovement.deleteMany({
      where: { companyId },
    });
    await prisma.stockItem.deleteMany({
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
    await prisma.auditLog.updateMany({
      where: { companyId },
      data: { companyId: null },
    });
    await prisma.company.deleteMany({
      where: { id: companyId },
    });
  }

  if (userId) {
    await prisma.auditLog.updateMany({
      where: { userId },
      data: { userId: null },
    });
    await prisma.refreshSession.deleteMany({
      where: { userId },
    });
    await prisma.userCompanyMembership.deleteMany({
      where: { userId },
    });
    await prisma.user.deleteMany({
      where: { id: userId },
    });
  }
});

test('D406 generează structură SAF-T extinsă (MasterFiles + Entries + SourceDocuments)', async () => {
  assert.ok(companyId, 'Fixture company lipsă');

  const payload = await buildD406Xml(companyId, {
    period: '2026-02',
    start: new Date('2026-02-01T00:00:00.000Z'),
    end: new Date('2026-02-28T23:59:59.999Z'),
  });

  assert.match(payload.xml, /<MasterFiles>/);
  assert.match(payload.xml, /<GeneralLedgerAccounts>/);
  assert.match(payload.xml, /<Customers>/);
  assert.match(payload.xml, /<Suppliers>/);
  assert.match(payload.xml, /<Products>/);
  assert.match(payload.xml, /<Assets>/);
  assert.match(payload.xml, /<GeneralLedgerEntries>/);
  assert.match(payload.xml, /<Journal>/);
  assert.match(payload.xml, /<Transaction>/);
  assert.match(payload.xml, /<Line>/);
  assert.match(payload.xml, /<SourceDocuments>/);
  assert.match(payload.xml, /<SalesInvoices>/);
  assert.match(payload.xml, /<PurchaseInvoices>/);
  assert.match(payload.xml, /<AccountType>ASSET<\/AccountType>/);
  assert.match(payload.xml, /<InvoiceType>FT<\/InvoiceType>/);
  assert.match(payload.xml, /<InvoiceType>PI<\/InvoiceType>/);
  assert.match(payload.xml, new RegExp(`<InvoiceNo>${invoiceNumber}</InvoiceNo>`));
  assert.match(payload.xml, new RegExp(`<InvoiceNo>${supplierInvoiceNumber}</InvoiceNo>`));
  assert.ok(payload.rowCount > 0, 'D406 trebuie să raporteze cel puțin un rând exportat.');
});

test('D406 trece validarea XSD fără erori când validatorul local este disponibil', async () => {
  assert.ok(companyId, 'Fixture company lipsă');

  const payload = await buildD406Xml(companyId, {
    period: '2026-02',
    start: new Date('2026-02-01T00:00:00.000Z'),
    end: new Date('2026-02-28T23:59:59.999Z'),
  });

  const validation = await validateAnafPayload(payload, true);
  assert.equal(validation.declaration, 'D406');

  if (!validation.xsd.performed) {
    assert.equal(validation.xsd.valid, null);
    assert.equal(validation.xsd.errors.length, 0);
    assert.ok(validation.xsd.warnings.length > 0);
    return;
  }

  assert.equal(validation.xsd.valid, true, `D406 invalid XSD: ${validation.xsd.errors.join(' | ')}`);
  assert.equal(validation.xsd.errors.length, 0);
});

test('D406 report de conformitate evidențiază mapările și scorul de calitate', async () => {
  assert.ok(companyId, 'Fixture company lipsă');

  const report = await buildD406ConformityReport(companyId, {
    period: '2026-02',
    start: new Date('2026-02-01T00:00:00.000Z'),
    end: new Date('2026-02-28T23:59:59.999Z'),
  });

  assert.equal(report.declaration, 'D406');
  assert.equal(report.period, '2026-02');
  assert.ok(report.score >= 0 && report.score <= 100);
  assert.ok(report.totals.salesInvoices >= 1);
  assert.ok(report.totals.purchaseInvoices >= 1);
  assert.ok(report.mappings.accountTypeCodes.includes('ASSET'));
  assert.ok(report.mappings.accountTypeCodes.includes('REVENUE'));
  assert.deepEqual(report.mappings.salesInvoiceTypes, ['FT']);
  assert.deepEqual(report.mappings.purchaseInvoiceTypes, ['PI']);
  assert.equal(report.blockingIssues.length, 0, `Blocking issues neașteptate: ${report.blockingIssues.join(' | ')}`);
});
