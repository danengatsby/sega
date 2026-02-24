import 'dotenv/config';

import bcrypt from 'bcrypt';
import {
  AccountType,
  InvoiceKind,
  InvoiceStatus,
  JournalEntryStatus,
  PaymentMethod,
  PayrollStatus,
  Role,
  SupplierInvoiceApprovalStatus,
  SupplierInvoiceStatus,
} from '@prisma/client';
import { prisma } from '../../src/lib/prisma.js';

const DEMO_ACCOUNTANT_EMAIL = process.env.DEMO_ACCOUNTANT_EMAIL?.trim() || 'contabil.3firme@sega.local';
const DEMO_ACCOUNTANT_PASSWORD = process.env.DEMO_ACCOUNTANT_PASSWORD?.trim() || 'ContabilDemo#2026';
const DEMO_ACCOUNTANT_NAME = process.env.DEMO_ACCOUNTANT_NAME?.trim() || 'Contabil Demo 3 Firme';
const DEMO_PERIODS = ['2026-01', '2026-02'] as const;

const DEMO_COMPANIES = [
  { code: 'DEMOALPHA', name: 'Demo Alpha Accounting SRL', cui: 'RO90000001' },
  { code: 'DEMOBETA', name: 'Demo Beta Accounting SRL', cui: 'RO90000002' },
  { code: 'DEMOGAMMA', name: 'Demo Gamma Accounting SRL', cui: 'RO90000003' },
] as const;

const ACCOUNT_TEMPLATES: Array<{ code: string; name: string; type: AccountType }> = [
  { code: '401', name: 'Furnizori', type: AccountType.LIABILITY },
  { code: '4111', name: 'Clienți', type: AccountType.ASSET },
  { code: '4426', name: 'TVA deductibilă', type: AccountType.ASSET },
  { code: '4427', name: 'TVA colectată', type: AccountType.LIABILITY },
  { code: '5121', name: 'Conturi la bănci în lei', type: AccountType.ASSET },
  { code: '628', name: 'Alte cheltuieli cu servicii executate de terți', type: AccountType.EXPENSE },
  { code: '641', name: 'Cheltuieli cu salariile personalului', type: AccountType.EXPENSE },
  { code: '701', name: 'Venituri din vânzarea produselor finite', type: AccountType.REVENUE },
];

type SeedPeriod = (typeof DEMO_PERIODS)[number];

function buildDate(period: SeedPeriod, day: number): Date {
  const [yearRaw, monthRaw] = period.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  return new Date(Date.UTC(year, month - 1, day, 9, 0, 0, 0));
}

function sanitizeCompanyCode(code: string): string {
  return code.replace(/[^A-Z0-9]/g, '');
}

function computePeriodAmounts(companyIndex: number, periodIndex: number): {
  salesSubtotal: number;
  salesVat: number;
  purchaseSubtotal: number;
  purchaseVat: number;
  invoicePaidAmount: number;
  supplierPaidAmount: number;
  grossSalary: number;
} {
  const salesSubtotal = 10000 + companyIndex * 1400 + periodIndex * 900;
  const salesVat = Number((salesSubtotal * 0.19).toFixed(2));
  const purchaseSubtotal = 4200 + companyIndex * 700 + periodIndex * 450;
  const purchaseVat = Number((purchaseSubtotal * 0.19).toFixed(2));
  const salesTotal = salesSubtotal + salesVat;
  const purchaseTotal = purchaseSubtotal + purchaseVat;
  const invoicePaidAmount = periodIndex === 0 ? salesTotal : Number((salesTotal * 0.65).toFixed(2));
  const supplierPaidAmount = periodIndex === 0 ? purchaseTotal : Number((purchaseTotal * 0.55).toFixed(2));
  const grossSalary = 7600 + companyIndex * 500 + periodIndex * 250;

  return {
    salesSubtotal,
    salesVat,
    purchaseSubtotal,
    purchaseVat,
    invoicePaidAmount,
    supplierPaidAmount,
    grossSalary,
  };
}

async function replaceJournalLines(
  entryId: string,
  lines: Array<{
    accountId: string;
    debit: number;
    credit: number;
    explanation: string;
  }>,
): Promise<void> {
  await prisma.journalLine.deleteMany({
    where: {
      entryId,
    },
  });

  await prisma.journalLine.createMany({
    data: lines.map((line) => ({
      entryId,
      accountId: line.accountId,
      debit: line.debit,
      credit: line.credit,
      explanation: line.explanation,
    })),
  });
}

async function seedCompanyData(
  userId: string,
  company: { id: string; code: string; name: string; cui: string },
  companyIndex: number,
): Promise<void> {
  const normalizedCode = sanitizeCompanyCode(company.code);
  const accountIds = new Map<string, string>();

  for (const account of ACCOUNT_TEMPLATES) {
    const upserted = await prisma.account.upsert({
      where: {
        companyId_code: {
          companyId: company.id,
          code: account.code,
        },
      },
      update: {
        name: account.name,
        type: account.type,
        currency: 'RON',
        isActive: true,
      },
      create: {
        companyId: company.id,
        code: account.code,
        name: account.name,
        type: account.type,
        currency: 'RON',
        isActive: true,
      },
      select: {
        id: true,
        code: true,
      },
    });
    accountIds.set(upserted.code, upserted.id);
  }

  const customer = await prisma.partner.upsert({
    where: {
      companyId_cui: {
        companyId: company.id,
        cui: `${company.cui}C`,
      },
    },
    update: {
      name: `${company.name} - Client Demo`,
      type: 'CUSTOMER',
      iban: `RO74SEGA${String(companyIndex + 1).padStart(4, '0')}0000000000000001`,
      email: `client-${company.code.toLowerCase()}@demo.local`,
    },
    create: {
      companyId: company.id,
      name: `${company.name} - Client Demo`,
      cui: `${company.cui}C`,
      type: 'CUSTOMER',
      iban: `RO74SEGA${String(companyIndex + 1).padStart(4, '0')}0000000000000001`,
      email: `client-${company.code.toLowerCase()}@demo.local`,
    },
    select: {
      id: true,
    },
  });

  const supplier = await prisma.partner.upsert({
    where: {
      companyId_cui: {
        companyId: company.id,
        cui: `${company.cui}S`,
      },
    },
    update: {
      name: `${company.name} - Furnizor Demo`,
      type: 'SUPPLIER',
      iban: `RO75SEGA${String(companyIndex + 1).padStart(4, '0')}0000000000000002`,
      email: `supplier-${company.code.toLowerCase()}@demo.local`,
    },
    create: {
      companyId: company.id,
      name: `${company.name} - Furnizor Demo`,
      cui: `${company.cui}S`,
      type: 'SUPPLIER',
      iban: `RO75SEGA${String(companyIndex + 1).padStart(4, '0')}0000000000000002`,
      email: `supplier-${company.code.toLowerCase()}@demo.local`,
    },
    select: {
      id: true,
    },
  });

  const employee = await prisma.employee.upsert({
    where: {
      companyId_cnp: {
        companyId: company.id,
        cnp: `1900101${String(companyIndex + 1).padStart(6, '0')}`,
      },
    },
    update: {
      name: `Angajat Demo ${company.code}`,
      contractType: 'CIM',
      personalDeduction: 0,
      grossSalary: 7800 + companyIndex * 500,
      isActive: true,
    },
    create: {
      companyId: company.id,
      cnp: `1900101${String(companyIndex + 1).padStart(6, '0')}`,
      name: `Angajat Demo ${company.code}`,
      contractType: 'CIM',
      personalDeduction: 0,
      grossSalary: 7800 + companyIndex * 500,
      isActive: true,
      hiredAt: buildDate('2026-01', 2),
    },
    select: {
      id: true,
    },
  });

  const account401 = accountIds.get('401');
  const account4111 = accountIds.get('4111');
  const account4426 = accountIds.get('4426');
  const account4427 = accountIds.get('4427');
  const account5121 = accountIds.get('5121');
  const account628 = accountIds.get('628');
  const account701 = accountIds.get('701');

  if (!account401 || !account4111 || !account4426 || !account4427 || !account5121 || !account628 || !account701) {
    throw new Error(`Lipsesc conturi obligatorii pentru compania ${company.code}.`);
  }

  for (let periodIndex = 0; periodIndex < DEMO_PERIODS.length; periodIndex += 1) {
    const period = DEMO_PERIODS[periodIndex]!;
    const monthDigits = period.replace('-', '');
    const amounts = computePeriodAmounts(companyIndex, periodIndex);
    const salesTotal = amounts.salesSubtotal + amounts.salesVat;
    const purchaseTotal = amounts.purchaseSubtotal + amounts.purchaseVat;

    await prisma.accountingPeriod.upsert({
      where: {
        companyId_period: {
          companyId: company.id,
          period,
        },
      },
      update: {
        status: 'OPEN',
      },
      create: {
        companyId: company.id,
        period,
        status: 'OPEN',
      },
    });

    const invoice = await prisma.invoice.upsert({
      where: {
        companyId_number: {
          companyId: company.id,
          number: `INV-${normalizedCode}-${monthDigits}-001`,
        },
      },
      update: {
        partnerId: customer.id,
        kind: InvoiceKind.FISCAL,
        issueDate: buildDate(period, 10),
        dueDate: buildDate(period, 25),
        subtotal: amounts.salesSubtotal,
        vat: amounts.salesVat,
        total: salesTotal,
        currency: 'RON',
        status: period === '2026-01' ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID,
        description: `Factura demo ${period} - ${company.code}`,
      },
      create: {
        companyId: company.id,
        number: `INV-${normalizedCode}-${monthDigits}-001`,
        partnerId: customer.id,
        kind: InvoiceKind.FISCAL,
        issueDate: buildDate(period, 10),
        dueDate: buildDate(period, 25),
        subtotal: amounts.salesSubtotal,
        vat: amounts.salesVat,
        total: salesTotal,
        currency: 'RON',
        status: period === '2026-01' ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID,
        description: `Factura demo ${period} - ${company.code}`,
      },
      select: {
        id: true,
      },
    });

    const invoicePaymentReference = `DEMO-PAY-INV-${normalizedCode}-${monthDigits}`;
    await prisma.payment.deleteMany({
      where: {
        companyId: company.id,
        reference: invoicePaymentReference,
      },
    });
    await prisma.payment.create({
      data: {
        companyId: company.id,
        invoiceId: invoice.id,
        partnerId: customer.id,
        date: buildDate(period, 26),
        amount: amounts.invoicePaidAmount,
        method: PaymentMethod.BANK_TRANSFER,
        reference: invoicePaymentReference,
      },
    });

    const supplierInvoice = await prisma.supplierInvoice.upsert({
      where: {
        companyId_number: {
          companyId: company.id,
          number: `AP-${normalizedCode}-${monthDigits}-001`,
        },
      },
      update: {
        supplierId: supplier.id,
        receivedDate: buildDate(period, 12),
        dueDate: buildDate(period, 27),
        subtotal: amounts.purchaseSubtotal,
        vat: amounts.purchaseVat,
        total: purchaseTotal,
        currency: 'RON',
        status: period === '2026-01' ? SupplierInvoiceStatus.PAID : SupplierInvoiceStatus.PARTIALLY_PAID,
        approvalStatus: SupplierInvoiceApprovalStatus.APPROVED,
        approvalCurrentLevel: 4,
        approvalRequiredLevel: 4,
        approvalRequestedAt: buildDate(period, 12),
        approvalFinalizedAt: buildDate(period, 13),
        approvalFinalizedById: userId,
        approvalRejectedReason: null,
        description: `Factură furnizor demo ${period} - ${company.code}`,
      },
      create: {
        companyId: company.id,
        number: `AP-${normalizedCode}-${monthDigits}-001`,
        supplierId: supplier.id,
        receivedDate: buildDate(period, 12),
        dueDate: buildDate(period, 27),
        subtotal: amounts.purchaseSubtotal,
        vat: amounts.purchaseVat,
        total: purchaseTotal,
        currency: 'RON',
        status: period === '2026-01' ? SupplierInvoiceStatus.PAID : SupplierInvoiceStatus.PARTIALLY_PAID,
        approvalStatus: SupplierInvoiceApprovalStatus.APPROVED,
        approvalCurrentLevel: 4,
        approvalRequiredLevel: 4,
        approvalRequestedAt: buildDate(period, 12),
        approvalFinalizedAt: buildDate(period, 13),
        approvalFinalizedById: userId,
        description: `Factură furnizor demo ${period} - ${company.code}`,
      },
      select: {
        id: true,
      },
    });

    const supplierPaymentReference = `DEMO-PAY-AP-${normalizedCode}-${monthDigits}`;
    await prisma.supplierPayment.deleteMany({
      where: {
        companyId: company.id,
        reference: supplierPaymentReference,
      },
    });
    await prisma.supplierPayment.create({
      data: {
        companyId: company.id,
        supplierInvoiceId: supplierInvoice.id,
        supplierId: supplier.id,
        date: buildDate(period, 27),
        amount: amounts.supplierPaidAmount,
        method: PaymentMethod.BANK_TRANSFER,
        reference: supplierPaymentReference,
      },
    });

    const salesEntry = await prisma.journalEntry.upsert({
      where: {
        companyId_number: {
          companyId: company.id,
          number: `NC-${normalizedCode}-${monthDigits}-01`,
        },
      },
      update: {
        date: buildDate(period, 10),
        description: `Factură client demo ${period}`,
        period,
        status: JournalEntryStatus.VALIDATED,
        posted: true,
        sourceModule: 'DEMO_SEED',
        createdById: userId,
      },
      create: {
        companyId: company.id,
        number: `NC-${normalizedCode}-${monthDigits}-01`,
        date: buildDate(period, 10),
        description: `Factură client demo ${period}`,
        period,
        status: JournalEntryStatus.VALIDATED,
        posted: true,
        sourceModule: 'DEMO_SEED',
        createdById: userId,
      },
      select: {
        id: true,
      },
    });

    await replaceJournalLines(salesEntry.id, [
      { accountId: account4111, debit: salesTotal, credit: 0, explanation: 'Client facturat' },
      { accountId: account701, debit: 0, credit: amounts.salesSubtotal, explanation: 'Venituri produse' },
      { accountId: account4427, debit: 0, credit: amounts.salesVat, explanation: 'TVA colectată' },
    ]);

    const customerPaymentEntry = await prisma.journalEntry.upsert({
      where: {
        companyId_number: {
          companyId: company.id,
          number: `NC-${normalizedCode}-${monthDigits}-02`,
        },
      },
      update: {
        date: buildDate(period, 26),
        description: `Încasare client demo ${period}`,
        period,
        status: JournalEntryStatus.VALIDATED,
        posted: true,
        sourceModule: 'DEMO_SEED',
        createdById: userId,
      },
      create: {
        companyId: company.id,
        number: `NC-${normalizedCode}-${monthDigits}-02`,
        date: buildDate(period, 26),
        description: `Încasare client demo ${period}`,
        period,
        status: JournalEntryStatus.VALIDATED,
        posted: true,
        sourceModule: 'DEMO_SEED',
        createdById: userId,
      },
      select: {
        id: true,
      },
    });

    await replaceJournalLines(customerPaymentEntry.id, [
      { accountId: account5121, debit: amounts.invoicePaidAmount, credit: 0, explanation: 'Încasare prin bancă' },
      { accountId: account4111, debit: 0, credit: amounts.invoicePaidAmount, explanation: 'Stingere creanță client' },
    ]);

    const supplierEntry = await prisma.journalEntry.upsert({
      where: {
        companyId_number: {
          companyId: company.id,
          number: `NC-${normalizedCode}-${monthDigits}-03`,
        },
      },
      update: {
        date: buildDate(period, 12),
        description: `Factură furnizor demo ${period}`,
        period,
        status: JournalEntryStatus.VALIDATED,
        posted: true,
        sourceModule: 'DEMO_SEED',
        createdById: userId,
      },
      create: {
        companyId: company.id,
        number: `NC-${normalizedCode}-${monthDigits}-03`,
        date: buildDate(period, 12),
        description: `Factură furnizor demo ${period}`,
        period,
        status: JournalEntryStatus.VALIDATED,
        posted: true,
        sourceModule: 'DEMO_SEED',
        createdById: userId,
      },
      select: {
        id: true,
      },
    });

    await replaceJournalLines(supplierEntry.id, [
      { accountId: account628, debit: amounts.purchaseSubtotal, credit: 0, explanation: 'Cheltuială servicii' },
      { accountId: account4426, debit: amounts.purchaseVat, credit: 0, explanation: 'TVA deductibilă' },
      { accountId: account401, debit: 0, credit: purchaseTotal, explanation: 'Datorie furnizor' },
    ]);

    const supplierPaymentEntry = await prisma.journalEntry.upsert({
      where: {
        companyId_number: {
          companyId: company.id,
          number: `NC-${normalizedCode}-${monthDigits}-04`,
        },
      },
      update: {
        date: buildDate(period, 27),
        description: `Plată furnizor demo ${period}`,
        period,
        status: JournalEntryStatus.VALIDATED,
        posted: true,
        sourceModule: 'DEMO_SEED',
        createdById: userId,
      },
      create: {
        companyId: company.id,
        number: `NC-${normalizedCode}-${monthDigits}-04`,
        date: buildDate(period, 27),
        description: `Plată furnizor demo ${period}`,
        period,
        status: JournalEntryStatus.VALIDATED,
        posted: true,
        sourceModule: 'DEMO_SEED',
        createdById: userId,
      },
      select: {
        id: true,
      },
    });

    await replaceJournalLines(supplierPaymentEntry.id, [
      { accountId: account401, debit: amounts.supplierPaidAmount, credit: 0, explanation: 'Reducere datorie furnizor' },
      { accountId: account5121, debit: 0, credit: amounts.supplierPaidAmount, explanation: 'Plată din bancă' },
    ]);

    const cas = Number((amounts.grossSalary * 0.25).toFixed(2));
    const cass = Number((amounts.grossSalary * 0.1).toFixed(2));
    const taxable = Number((amounts.grossSalary - cas - cass).toFixed(2));
    const incomeTax = Number((taxable * 0.1).toFixed(2));
    const cam = Number((amounts.grossSalary * 0.0225).toFixed(2));
    const netSalary = Number((amounts.grossSalary - cas - cass - incomeTax).toFixed(2));

    const payrollRun = await prisma.payrollRun.upsert({
      where: {
        companyId_period: {
          companyId: company.id,
          period,
        },
      },
      update: {
        payDate: buildDate(period, 28),
        status: PayrollStatus.POSTED,
        totalGross: amounts.grossSalary,
        totalNet: netSalary,
        totalCas: cas,
        totalCass: cass,
        totalTax: incomeTax,
        totalCam: cam,
        createdById: userId,
      },
      create: {
        companyId: company.id,
        period,
        payDate: buildDate(period, 28),
        status: PayrollStatus.POSTED,
        totalGross: amounts.grossSalary,
        totalNet: netSalary,
        totalCas: cas,
        totalCass: cass,
        totalTax: incomeTax,
        totalCam: cam,
        createdById: userId,
      },
      select: {
        id: true,
      },
    });

    await prisma.payrollLine.upsert({
      where: {
        runId_employeeId: {
          runId: payrollRun.id,
          employeeId: employee.id,
        },
      },
      update: {
        grossSalary: amounts.grossSalary,
        personalDeduction: 0,
        cas,
        cass,
        incomeTax,
        cam,
        netSalary,
      },
      create: {
        runId: payrollRun.id,
        employeeId: employee.id,
        grossSalary: amounts.grossSalary,
        personalDeduction: 0,
        cas,
        cass,
        incomeTax,
        cam,
        netSalary,
      },
    });
  }
}

async function main(): Promise<void> {
  if (DEMO_ACCOUNTANT_PASSWORD.length < 12) {
    throw new Error('DEMO_ACCOUNTANT_PASSWORD trebuie să aibă cel puțin 12 caractere.');
  }

  const passwordHash = await bcrypt.hash(DEMO_ACCOUNTANT_PASSWORD, 12);
  const demoUser = await prisma.user.upsert({
    where: {
      email: DEMO_ACCOUNTANT_EMAIL,
    },
    update: {
      name: DEMO_ACCOUNTANT_NAME,
      role: Role.ACCOUNTANT,
      passwordHash,
      mustChangePassword: false,
      mfaEnabled: false,
      mfaSecret: null,
      mfaPendingSecret: null,
    },
    create: {
      email: DEMO_ACCOUNTANT_EMAIL,
      name: DEMO_ACCOUNTANT_NAME,
      role: Role.ACCOUNTANT,
      passwordHash,
      mustChangePassword: false,
      mfaEnabled: false,
    },
    select: {
      id: true,
      email: true,
    },
  });

  const companies = [];
  for (let index = 0; index < DEMO_COMPANIES.length; index += 1) {
    const companySeed = DEMO_COMPANIES[index]!;
    const company = await prisma.company.upsert({
      where: {
        code: companySeed.code,
      },
      update: {
        name: companySeed.name,
        cui: companySeed.cui,
        isActive: true,
      },
      create: {
        code: companySeed.code,
        name: companySeed.name,
        cui: companySeed.cui,
        isActive: true,
      },
      select: {
        id: true,
        code: true,
        name: true,
        cui: true,
      },
    });
    companies.push(company);

    await prisma.userCompanyMembership.upsert({
      where: {
        userId_companyId: {
          userId: demoUser.id,
          companyId: company.id,
        },
      },
      update: {
        role: Role.ACCOUNTANT,
        isDefault: false,
      },
      create: {
        userId: demoUser.id,
        companyId: company.id,
        role: Role.ACCOUNTANT,
        isDefault: false,
      },
    });
  }

  const companyIds = companies.map((company) => company.id);
  await prisma.userCompanyMembership.updateMany({
    where: {
      userId: demoUser.id,
      companyId: {
        in: companyIds,
      },
    },
    data: {
      isDefault: false,
    },
  });

  const defaultCompany = companies[0];
  if (!defaultCompany) {
    throw new Error('Nu există companii generate pentru seed.');
  }

  await prisma.userCompanyMembership.update({
    where: {
      userId_companyId: {
        userId: demoUser.id,
        companyId: defaultCompany.id,
      },
    },
    data: {
      isDefault: true,
    },
  });

  for (let companyIndex = 0; companyIndex < companies.length; companyIndex += 1) {
    const company = companies[companyIndex]!;
    await seedCompanyData(demoUser.id, company, companyIndex);
  }

  const summary = await Promise.all(
    companies.map(async (company) => {
      const [invoiceCount, supplierInvoiceCount, journalCount, payrollCount] = await Promise.all([
        prisma.invoice.count({
          where: {
            companyId: company.id,
            number: {
              contains: sanitizeCompanyCode(company.code),
            },
          },
        }),
        prisma.supplierInvoice.count({
          where: {
            companyId: company.id,
            number: {
              contains: sanitizeCompanyCode(company.code),
            },
          },
        }),
        prisma.journalEntry.count({
          where: {
            companyId: company.id,
            sourceModule: 'DEMO_SEED',
          },
        }),
        prisma.payrollRun.count({
          where: {
            companyId: company.id,
            period: {
              in: [...DEMO_PERIODS],
            },
          },
        }),
      ]);

      return {
        companyCode: company.code,
        periods: [...DEMO_PERIODS],
        invoices: invoiceCount,
        supplierInvoices: supplierInvoiceCount,
        journalEntries: journalCount,
        payrollRuns: payrollCount,
      };
    }),
  );

  console.log(
    JSON.stringify(
      {
        seededUser: demoUser.email,
        seededCompanies: companies.map((company) => company.code),
        periods: [...DEMO_PERIODS],
        summary,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
