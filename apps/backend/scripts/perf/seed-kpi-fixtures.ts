import 'dotenv/config';

import bcrypt from 'bcrypt';
import { InvoiceStatus, Role, SupplierInvoiceStatus } from '@prisma/client';
import { prisma } from '../../src/lib/prisma.js';
import { round2 } from '../../src/utils/number.js';

const PERF_COMPANY_CODE = process.env.PERF_COMPANY_CODE ?? 'default';
const PERF_USER_EMAIL = process.env.PERF_USER_EMAIL ?? 'perf.accountant@sega.local';
const PERF_USER_PASSWORD = process.env.PERF_USER_PASSWORD ?? 'PerfKpi!Pass2026';
const CUSTOMER_PARTNERS = readPositiveInt('PERF_CUSTOMER_PARTNERS', 120);
const SUPPLIER_PARTNERS = readPositiveInt('PERF_SUPPLIER_PARTNERS', 80);
const CUSTOMER_INVOICES = readPositiveInt('PERF_CUSTOMER_INVOICES', 2200);
const SUPPLIER_INVOICES = readPositiveInt('PERF_SUPPLIER_INVOICES', 1200);
const CUSTOMER_PREFIX = 'PERF KPI CUSTOMER';
const SUPPLIER_PREFIX = 'PERF KPI SUPPLIER';
const CUSTOMER_INVOICE_PREFIX = 'PERF-INV-';
const SUPPLIER_INVOICE_PREFIX = 'PERF-SUP-INV-';

function readPositiveInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} trebuie să fie număr întreg pozitiv.`);
  }
  return parsed;
}

function buildCui(prefix: string, value: number): string {
  const padded = String(value).padStart(7, '0');
  return `RO${prefix}${padded}`;
}

async function resolveCompanyId(): Promise<string> {
  const byCode = await prisma.company.findUnique({
    where: {
      code: PERF_COMPANY_CODE,
    },
    select: {
      id: true,
      code: true,
    },
  });

  if (byCode) {
    return byCode.id;
  }

  const fallback = await prisma.company.findFirst({
    where: {
      isActive: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
    select: {
      id: true,
      code: true,
    },
  });

  if (!fallback) {
    throw new Error('Nu există nicio companie activă pentru seed de performanță.');
  }

  console.warn(
    `PERF_COMPANY_CODE=${PERF_COMPANY_CODE} nu există. Se folosește compania ${fallback.code}.`,
  );
  return fallback.id;
}

async function upsertPerformanceUser(companyId: string): Promise<void> {
  const passwordHash = await bcrypt.hash(PERF_USER_PASSWORD, 12);
  const user = await prisma.user.upsert({
    where: {
      email: PERF_USER_EMAIL,
    },
    update: {
      passwordHash,
      role: Role.ACCOUNTANT,
      mustChangePassword: false,
      mfaEnabled: false,
      mfaSecret: null,
      mfaPendingSecret: null,
    },
    create: {
      email: PERF_USER_EMAIL,
      name: 'Performance Accountant',
      passwordHash,
      role: Role.ACCOUNTANT,
      mustChangePassword: false,
      mfaEnabled: false,
    },
    select: {
      id: true,
    },
  });

  await prisma.userCompanyMembership.upsert({
    where: {
      userId_companyId: {
        userId: user.id,
        companyId,
      },
    },
    update: {
      role: Role.ACCOUNTANT,
      isDefault: true,
    },
    create: {
      userId: user.id,
      companyId,
      role: Role.ACCOUNTANT,
      isDefault: true,
    },
  });
}

async function seedPartners(companyId: string): Promise<{ customerIds: string[]; supplierIds: string[] }> {
  const customerRows = Array.from({ length: CUSTOMER_PARTNERS }, (_value, index) => ({
    companyId,
    name: `${CUSTOMER_PREFIX} ${String(index + 1).padStart(4, '0')}`,
    type: 'CUSTOMER' as const,
    cui: buildCui('10', index + 1),
    iban: `RO49AAAA1B31007593${String(index + 1).padStart(6, '0')}`.slice(0, 24),
    email: `perf-customer-${index + 1}@sega.test`,
  }));

  const supplierRows = Array.from({ length: SUPPLIER_PARTNERS }, (_value, index) => ({
    companyId,
    name: `${SUPPLIER_PREFIX} ${String(index + 1).padStart(4, '0')}`,
    type: 'SUPPLIER' as const,
    cui: buildCui('20', index + 1),
    iban: `RO49AAAA1B31007594${String(index + 1).padStart(6, '0')}`.slice(0, 24),
    email: `perf-supplier-${index + 1}@sega.test`,
  }));

  await prisma.partner.createMany({
    data: [...customerRows, ...supplierRows],
    skipDuplicates: true,
  });

  const [customers, suppliers] = await Promise.all([
    prisma.partner.findMany({
      where: {
        companyId,
        name: {
          startsWith: CUSTOMER_PREFIX,
        },
      },
      select: {
        id: true,
      },
      orderBy: {
        name: 'asc',
      },
    }),
    prisma.partner.findMany({
      where: {
        companyId,
        name: {
          startsWith: SUPPLIER_PREFIX,
        },
      },
      select: {
        id: true,
      },
      orderBy: {
        name: 'asc',
      },
    }),
  ]);

  return {
    customerIds: customers.map((row) => row.id),
    supplierIds: suppliers.map((row) => row.id),
  };
}

function buildIssueDate(index: number): Date {
  const now = new Date();
  const dayOffset = index % 120;
  const date = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
  date.setHours(9, 0, 0, 0);
  return date;
}

function buildDueDate(issueDate: Date, index: number): Date {
  const dueOffsetDays = 7 + (index % 45);
  return new Date(issueDate.getTime() + dueOffsetDays * 24 * 60 * 60 * 1000);
}

async function seedCustomerInvoices(companyId: string, customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) {
    throw new Error('Nu există parteneri customer pentru seed facturi.');
  }

  const invoiceRows = Array.from({ length: CUSTOMER_INVOICES }, (_value, index) => {
    const issueDate = buildIssueDate(index);
    const dueDate = buildDueDate(issueDate, index);
    const subtotal = round2(100 + ((index % 300) + 1) * 3.15);
    const vat = round2(subtotal * 0.19);
    const total = round2(subtotal + vat);
    const status =
      index % 10 === 0
        ? InvoiceStatus.PAID
        : index % 4 === 0
          ? InvoiceStatus.PARTIALLY_PAID
          : InvoiceStatus.ISSUED;

    return {
      companyId,
      number: `${CUSTOMER_INVOICE_PREFIX}${String(index + 1).padStart(6, '0')}`,
      partnerId: customerIds[index % customerIds.length]!,
      issueDate,
      dueDate,
      subtotal,
      vat,
      total,
      status,
      description: `KPI fixture invoice ${index + 1} PERF-SEED`,
    };
  });

  await prisma.invoice.createMany({
    data: invoiceRows,
    skipDuplicates: true,
  });
}

async function seedSupplierInvoices(companyId: string, supplierIds: string[]): Promise<void> {
  if (supplierIds.length === 0) {
    throw new Error('Nu există parteneri supplier pentru seed facturi furnizor.');
  }

  const supplierInvoiceRows = Array.from({ length: SUPPLIER_INVOICES }, (_value, index) => {
    const receivedDate = buildIssueDate(index);
    const dueDate = buildDueDate(receivedDate, index);
    const subtotal = round2(140 + ((index % 180) + 1) * 2.6);
    const vat = round2(subtotal * 0.19);
    const total = round2(subtotal + vat);
    const status =
      index % 8 === 0
        ? SupplierInvoiceStatus.PAID
        : index % 3 === 0
          ? SupplierInvoiceStatus.PARTIALLY_PAID
          : SupplierInvoiceStatus.RECEIVED;

    return {
      companyId,
      number: `${SUPPLIER_INVOICE_PREFIX}${String(index + 1).padStart(6, '0')}`,
      supplierId: supplierIds[index % supplierIds.length]!,
      receivedDate,
      dueDate,
      subtotal,
      vat,
      total,
      status,
      description: `KPI fixture supplier invoice ${index + 1} PERF-SEED`,
    };
  });

  await prisma.supplierInvoice.createMany({
    data: supplierInvoiceRows,
    skipDuplicates: true,
  });
}

async function printSummary(companyId: string): Promise<void> {
  const [customerInvoices, supplierInvoices, partners] = await Promise.all([
    prisma.invoice.count({
      where: {
        companyId,
        number: {
          startsWith: CUSTOMER_INVOICE_PREFIX,
        },
      },
    }),
    prisma.supplierInvoice.count({
      where: {
        companyId,
        number: {
          startsWith: SUPPLIER_INVOICE_PREFIX,
        },
      },
    }),
    prisma.partner.count({
      where: {
        companyId,
        OR: [
          {
            name: {
              startsWith: CUSTOMER_PREFIX,
            },
          },
          {
            name: {
              startsWith: SUPPLIER_PREFIX,
            },
          },
        ],
      },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        companyCode: PERF_COMPANY_CODE,
        perfUserEmail: PERF_USER_EMAIL,
        partners,
        customerInvoices,
        supplierInvoices,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  if (PERF_USER_PASSWORD.length < 12) {
    throw new Error('PERF_USER_PASSWORD trebuie să aibă minim 12 caractere.');
  }

  const companyId = await resolveCompanyId();
  await upsertPerformanceUser(companyId);
  const partnerIds = await seedPartners(companyId);
  await seedCustomerInvoices(companyId, partnerIds.customerIds);
  await seedSupplierInvoices(companyId, partnerIds.supplierIds);
  await printSummary(companyId);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
