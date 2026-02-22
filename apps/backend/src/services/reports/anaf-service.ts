import { AccountType, InvoiceKind, InvoiceStatus, SupplierInvoiceStatus } from '@prisma/client';
import { env, envMeta } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import type { AnafDeclarationType } from '../../utils/anaf.js';
import { bareCui, declarationCode, validateAnafProfile } from '../../utils/anaf.js';
import { round2, toNumber } from '../../utils/number.js';
import { validateXmlWithXsd } from '../../utils/xsd.js';
import { xmlEscape } from './helpers.js';
import type { AnafDeclarationPayload, AnafPeriod, AnafValidationSummary } from './types.js';

export interface AnafBusinessProfileValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const ANAF_DEFAULTS = {
  companyName: 'SEGA DEMO SRL',
  companyAddress: 'Bucuresti, Romania',
  companyCui: 'RO00000000',
  companyCaen: '6201',
  declarantName: 'Administrator',
  declarantFunction: 'Administrator',
} as const;

const D300_TAXABLE_INVOICE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.ISSUED,
  InvoiceStatus.PARTIALLY_PAID,
  InvoiceStatus.PAID,
];

const D300_DEDUCTIBLE_SUPPLIER_INVOICE_STATUSES: SupplierInvoiceStatus[] = [
  SupplierInvoiceStatus.RECEIVED,
  SupplierInvoiceStatus.PARTIALLY_PAID,
  SupplierInvoiceStatus.PAID,
];

interface D300VatAmountsInput {
  invoiceVatCollected: number;
  supplierVatDeductible: number;
  journalCollected: number | null;
  journalDeductible: number | null;
}

export function resolveD300VatAmounts(input: D300VatAmountsInput): {
  vatCollected: number;
  vatDeductible: number;
  vatBalance: number;
} {
  const vatCollected = input.journalCollected ?? input.invoiceVatCollected;
  const vatDeductible = input.journalDeductible ?? input.supplierVatDeductible;
  return {
    vatCollected: round2(vatCollected),
    vatDeductible: round2(vatDeductible),
    vatBalance: round2(vatCollected - vatDeductible),
  };
}

function normalizeForCompare(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function parseAnafPeriodParts(period: string): { year: number; month: number; monthText: string } {
  const yearText = period.slice(0, 4);
  const monthText = period.slice(5, 7);
  return {
    year: Number(yearText),
    month: Number(monthText),
    monthText,
  };
}

function parseAnafYear(period: string): number {
  return Number(period.slice(0, 4));
}

function buildAnnualRange(year: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
  };
}

function quarterFromMonth(month: number): number {
  return Math.min(4, Math.max(1, Math.floor((month - 1) / 3) + 1));
}

function isNonRomanianCui(cui: string | null | undefined): boolean {
  if (!cui) {
    return false;
  }
  const normalized = cui.trim().toUpperCase();
  return normalized.length > 0 && !normalized.startsWith('RO');
}

function splitDeclarantName(raw: string): { lastName: string; firstName: string } {
  const parts = raw
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return { lastName: 'Declarant', firstName: 'Declarant' };
  }

  if (parts.length === 1) {
    const onlyPart = parts[0] ?? 'Declarant';
    return { lastName: onlyPart, firstName: onlyPart };
  }

  const lastName = parts[0] ?? 'Declarant';
  const firstName = parts.slice(1).join(' ');

  return {
    lastName,
    firstName: firstName.length > 0 ? firstName : lastName,
  };
}

function normalizeText(value: string, fallback: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  const selected = normalized.length > 0 ? normalized : fallback;
  return selected.slice(0, maxLength);
}

function normalizePhone(value: string): string {
  const phone = value.trim();
  if (phone.length === 0) {
    return '0000000000';
  }
  return phone.slice(0, 15);
}

function toAnafUnsignedInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function toAnafSignedInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value);
}

function toAnafCuiForXsd(raw: string): string {
  const digits = bareCui(raw).replace(/\D+/g, '');
  if (/^[1-9]\d{1,9}$/.test(digits) || /^[1-9]\d{12}$/.test(digits)) {
    return digits;
  }
  return '12345678';
}

function toDeclarantCif(raw: string): string {
  const digits = bareCui(raw).replace(/\D+/g, '');
  if (/^\d{1,13}$/.test(digits)) {
    return digits;
  }
  return '0';
}

function toAnafCaen(raw: string): string {
  const digits = raw.trim().replace(/\D+/g, '');
  if (digits.length >= 4) {
    return digits.slice(0, 4);
  }
  return '6201';
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toSaftAmount(value: number): string {
  if (!Number.isFinite(value)) {
    return '0.00';
  }
  return round2(value).toFixed(2);
}

function mapAccountTypeToSaftCode(type: AccountType): 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE' {
  switch (type) {
    case AccountType.ASSET:
      return 'ASSET';
    case AccountType.LIABILITY:
      return 'LIABILITY';
    case AccountType.EQUITY:
      return 'EQUITY';
    case AccountType.REVENUE:
      return 'REVENUE';
    case AccountType.EXPENSE:
      return 'EXPENSE';
    default:
      return 'ASSET';
  }
}

function mapSalesInvoiceTypeToSaftCode(kind: InvoiceKind): 'FT' | 'PF' | 'CN' {
  switch (kind) {
    case InvoiceKind.PROFORMA:
      return 'PF';
    case InvoiceKind.STORNO:
      return 'CN';
    case InvoiceKind.FISCAL:
      return 'FT';
    default:
      return 'FT';
  }
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export interface D406ConformityReport {
  declaration: 'D406';
  period: string;
  generatedAt: string;
  score: number;
  totals: {
    accounts: number;
    customers: number;
    suppliers: number;
    products: number;
    assets: number;
    journalEntries: number;
    journalLines: number;
    salesInvoices: number;
    purchaseInvoices: number;
  };
  missing: {
    accountsWithoutCode: number;
    accountsWithoutName: number;
    customersWithoutName: number;
    customersWithoutTaxId: number;
    suppliersWithoutName: number;
    suppliersWithoutTaxId: number;
    productsWithoutCode: number;
    productsWithoutName: number;
    assetsWithoutCode: number;
    assetsWithoutName: number;
    journalEntriesWithoutNumber: number;
    journalEntriesWithoutLines: number;
    journalLinesWithoutAccount: number;
    salesInvoicesWithoutPartner: number;
    salesInvoicesWithoutNumber: number;
    salesInvoicesWithoutCustomerTaxId: number;
    purchaseInvoicesWithoutSupplier: number;
    purchaseInvoicesWithoutNumber: number;
    purchaseInvoicesWithoutSupplierTaxId: number;
  };
  mappings: {
    accountTypeCodes: string[];
    salesInvoiceTypes: string[];
    purchaseInvoiceTypes: string[];
  };
  blockingIssues: string[];
  warnings: string[];
}

export function validateAnafBusinessProfile(): AnafBusinessProfileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!envMeta.anafProfile.companyCuiProvided) {
    errors.push('ANAF_COMPANY_CUI lipsește din env. Fallback-ul implicit nu este permis în strict mode.');
  }

  if (!envMeta.anafProfile.companyCaenProvided) {
    errors.push('ANAF_COMPANY_CAEN lipsește din env. Fallback-ul implicit nu este permis în strict mode.');
  }

  if (!envMeta.anafProfile.companyNameProvided) {
    errors.push('ANAF_COMPANY_NAME lipsește din env. Completează denumirea reală a companiei.');
  }

  if (!envMeta.anafProfile.companyAddressProvided) {
    errors.push('ANAF_COMPANY_ADDRESS lipsește din env. Completează adresa reală a companiei.');
  }

  const companyName = env.ANAF_COMPANY_NAME.trim();
  if (companyName.length < 2) {
    errors.push('ANAF_COMPANY_NAME este invalid (prea scurt).');
  }

  if (normalizeForCompare(companyName) === normalizeForCompare(ANAF_DEFAULTS.companyName)) {
    errors.push('ANAF_COMPANY_NAME folosește valoare demo implicită.');
  }

  const companyAddress = env.ANAF_COMPANY_ADDRESS.trim();
  if (companyAddress.length < 5) {
    errors.push('ANAF_COMPANY_ADDRESS este invalid (prea scurt).');
  }

  if (normalizeForCompare(companyAddress) === normalizeForCompare(ANAF_DEFAULTS.companyAddress)) {
    errors.push('ANAF_COMPANY_ADDRESS folosește valoare demo implicită.');
  }

  const cuiDigits = bareCui(env.ANAF_COMPANY_CUI).replace(/\D+/g, '');
  const isValidCui = /^[1-9]\d{1,9}$/.test(cuiDigits) || /^[1-9]\d{12}$/.test(cuiDigits);
  if (!isValidCui) {
    errors.push('ANAF_COMPANY_CUI este invalid. Introdu un CUI real (fără fallback demo).');
  }

  if (cuiDigits === bareCui(ANAF_DEFAULTS.companyCui).replace(/\D+/g, '') || cuiDigits === '12345678') {
    errors.push('ANAF_COMPANY_CUI folosește o valoare demo/placeholder.');
  }

  const caenDigits = env.ANAF_COMPANY_CAEN.trim().replace(/\D+/g, '');
  if (!/^\d{4}$/.test(caenDigits)) {
    errors.push('ANAF_COMPANY_CAEN este invalid. Trebuie să conțină exact 4 cifre.');
  }

  if (normalizeForCompare(env.ANAF_COMPANY_CAEN) === normalizeForCompare(ANAF_DEFAULTS.companyCaen)) {
    warnings.push('ANAF_COMPANY_CAEN este egal cu valoarea implicită (6201). Verifică dacă este CAEN-ul real.');
  }

  if (!envMeta.anafProfile.declarantNameProvided) {
    warnings.push('ANAF_DECLARANT_NAME nu este setat explicit în env.');
  }

  if (!envMeta.anafProfile.declarantFunctionProvided) {
    warnings.push('ANAF_DECLARANT_FUNCTION nu este setat explicit în env.');
  }

  if (normalizeForCompare(env.ANAF_DECLARANT_NAME) === normalizeForCompare(ANAF_DEFAULTS.declarantName)) {
    warnings.push('ANAF_DECLARANT_NAME este valoarea implicită (Administrator).');
  }

  if (normalizeForCompare(env.ANAF_DECLARANT_FUNCTION) === normalizeForCompare(ANAF_DEFAULTS.declarantFunction)) {
    warnings.push('ANAF_DECLARANT_FUNCTION este valoarea implicită (Administrator).');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export async function buildD300Xml(companyId: string, period: AnafPeriod): Promise<AnafDeclarationPayload> {
  const [outgoingVatSummary, incomingVatSummary, outgoingCount, incomingCount, vatAccounts] = await Promise.all([
    prisma.invoice.aggregate({
      where: {
        companyId,
        status: {
          in: D300_TAXABLE_INVOICE_STATUSES,
        },
        issueDate: {
          gte: period.start,
          lte: period.end,
        },
      },
      _sum: {
        vat: true,
      },
    }),
    prisma.supplierInvoice.aggregate({
      where: {
        companyId,
        status: {
          in: D300_DEDUCTIBLE_SUPPLIER_INVOICE_STATUSES,
        },
        receivedDate: {
          gte: period.start,
          lte: period.end,
        },
      },
      _sum: {
        vat: true,
      },
    }),
    prisma.invoice.count({
      where: {
        companyId,
        status: {
          in: D300_TAXABLE_INVOICE_STATUSES,
        },
        issueDate: {
          gte: period.start,
          lte: period.end,
        },
      },
    }),
    prisma.supplierInvoice.count({
      where: {
        companyId,
        status: {
          in: D300_DEDUCTIBLE_SUPPLIER_INVOICE_STATUSES,
        },
        receivedDate: {
          gte: period.start,
          lte: period.end,
        },
      },
    }),
    prisma.account.findMany({
      where: {
        companyId,
        code: {
          in: ['4426', '4427'],
        },
      },
      select: {
        id: true,
        code: true,
      },
    }),
  ]);

  const invoiceVatCollected = round2(toNumber(outgoingVatSummary._sum.vat));
  const supplierVatDeductible = round2(toNumber(incomingVatSummary._sum.vat));

  const vatAccountIdByCode = new Map(vatAccounts.map((account) => [account.code, account.id]));
  const vatJournalAccountIds = Array.from(vatAccountIdByCode.values());
  const vatJournalRows =
    vatJournalAccountIds.length > 0
      ? await prisma.journalLine.groupBy({
          by: ['accountId'],
          where: {
            accountId: {
              in: vatJournalAccountIds,
            },
            entry: {
              companyId,
              posted: true,
              date: {
                gte: period.start,
                lte: period.end,
              },
            },
          },
          _sum: {
            debit: true,
            credit: true,
          },
        })
      : [];

  const vatJournalByCode = new Map<
    string,
    {
      debit: number;
      credit: number;
    }
  >();
  for (const row of vatJournalRows) {
    const code = vatAccounts.find((account) => account.id === row.accountId)?.code;
    if (!code) {
      continue;
    }
    vatJournalByCode.set(code, {
      debit: toNumber(row._sum.debit),
      credit: toNumber(row._sum.credit),
    });
  }

  const journalCollected = vatJournalByCode.has('4427')
    ? round2((vatJournalByCode.get('4427')?.credit ?? 0) - (vatJournalByCode.get('4427')?.debit ?? 0))
    : null;
  const journalDeductible = vatJournalByCode.has('4426')
    ? round2((vatJournalByCode.get('4426')?.debit ?? 0) - (vatJournalByCode.get('4426')?.credit ?? 0))
    : null;

  const { vatCollected, vatDeductible, vatBalance } = resolveD300VatAmounts({
    invoiceVatCollected,
    supplierVatDeductible,
    journalCollected,
    journalDeductible,
  });

  const { year, month, monthText } = parseAnafPeriodParts(period.period);
  const declarant = splitDeclarantName(env.ANAF_DECLARANT_NAME);
  const companyCui = toAnafCuiForXsd(env.ANAF_COMPANY_CUI);
  const companyName = normalizeText(env.ANAF_COMPANY_NAME, 'SEGA DEMO SRL', 200);
  const companyAddress = normalizeText(env.ANAF_COMPANY_ADDRESS, 'Bucuresti, Romania', 1000);
  const companyCaen = toAnafCaen(env.ANAF_COMPANY_CAEN);
  const totalPlataA = toAnafSignedInteger(vatBalance);

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v10" luna="${month}" an="${year}" depusReprezentant="0" bifa_interne="0" temei="0" nume_declar="${xmlEscape(normalizeText(declarant.lastName, 'Declarant', 75))}" prenume_declar="${xmlEscape(normalizeText(declarant.firstName, 'Declarant', 75))}" functie_declar="${xmlEscape(normalizeText(env.ANAF_DECLARANT_FUNCTION, 'Administrator', 50))}" cui="${xmlEscape(companyCui)}" den="${xmlEscape(companyName)}" adresa="${xmlEscape(companyAddress)}" banca="TREZORERIE" cont="RO00TREZ0000000000000000" caen="${xmlEscape(companyCaen)}" tip_decont="L" pro_rata="0" bifa_cereale="N" bifa_mob="N" bifa_disp="N" bifa_cons="N" solicit_ramb="N" nr_evid="${year}${monthText}01" totalPlata_A="${totalPlataA}"/>`,
  ].join('\n');

  return {
    type: 'd300',
    period: period.period,
    xml,
    rowCount: outgoingCount + incomingCount,
  };
}

export async function buildD394Xml(companyId: string, period: AnafPeriod): Promise<AnafDeclarationPayload> {
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      status: {
        not: InvoiceStatus.CANCELLED,
      },
      issueDate: {
        gte: period.start,
        lte: period.end,
      },
    },
    include: {
      partner: true,
    },
    orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
  });

  const uniquePartners = new Set(invoices.map((invoice) => invoice.partner.cui ?? invoice.partner.name));
  const vatTotal = round2(invoices.reduce((sum, invoice) => sum + toNumber(invoice.vat), 0));
  const total = round2(invoices.reduce((sum, invoice) => sum + toNumber(invoice.total), 0));

  const { year, month } = parseAnafPeriodParts(period.period);
  const companyCui = toAnafCuiForXsd(env.ANAF_COMPANY_CUI);
  const companyCaen = toAnafCaen(env.ANAF_COMPANY_CAEN);
  const companyName = normalizeText(env.ANAF_COMPANY_NAME, 'SEGA DEMO SRL', 200);
  const companyAddress = normalizeText(env.ANAF_COMPANY_ADDRESS, 'Bucuresti, Romania', 1000);
  const declarantName = normalizeText(env.ANAF_DECLARANT_NAME, 'Administrator', 75);
  const declarantFunction = normalizeText(env.ANAF_DECLARANT_FUNCTION, 'Administrator', 100);
  const invoiceCount = toAnafUnsignedInteger(invoices.length);
  const partnerCount = toAnafUnsignedInteger(uniquePartners.size);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<declaratie394 xmlns="mfp:anaf:dgti:d394:declaratie:v4" luna="${month}" an="${year}" tip_D394="L" sistemTVA="0" op_efectuate="${invoiceCount > 0 ? 1 : 0}" cui="${xmlEscape(companyCui)}" caen="${xmlEscape(companyCaen)}" den="${xmlEscape(companyName)}" adresa="${xmlEscape(companyAddress)}" telefon="${normalizePhone('')}" totalPlata_A="${toAnafSignedInteger(vatTotal)}" denR="${xmlEscape(companyName)}" functie_reprez="${xmlEscape(declarantFunction)}" adresaR="${xmlEscape(companyAddress)}" tip_intocmit="0" den_intocmit="${xmlEscape(declarantName)}" cif_intocmit="${toDeclarantCif(env.ANAF_COMPANY_CUI)}" optiune="0" prsAfiliat="0">`,
  );
  lines.push(
    `  <informatii nrCui1="${partnerCount}" nrCui2="0" nrCui3="0" nrCui4="0" nr_BF_i1="0" incasari_i1="${toAnafSignedInteger(total)}" incasari_i2="0" nrFacturi_terti="${invoiceCount}" nrFacturi_benef="0" nrFacturi="${invoiceCount}" nrFacturiL_PF="0" nrFacturiLS_PF="0" val_LS_PF="0" tvaDedAI24="0" tvaDedAI20="0" tvaDedAI19="0" tvaDedAI9="0" tvaDedAI5="0" solicit="0" />`,
  );
  lines.push('</declaratie394>');

  return {
    type: 'd394',
    period: period.period,
    xml: lines.join('\n'),
    rowCount: invoices.length,
  };
}

export async function buildD112Xml(companyId: string, period: AnafPeriod): Promise<AnafDeclarationPayload> {
  const runs = await prisma.payrollRun.findMany({
    where: {
      companyId,
      payDate: {
        gte: period.start,
        lte: period.end,
      },
    },
    include: {
      lines: {
        include: {
          employee: true,
        },
      },
    },
    orderBy: [{ period: 'asc' }],
  });

  const totals = runs.reduce(
    (acc, run) => {
      acc.gross = round2(acc.gross + toNumber(run.totalGross));
      acc.cas = round2(acc.cas + toNumber(run.totalCas));
      acc.cass = round2(acc.cass + toNumber(run.totalCass));
      acc.tax = round2(acc.tax + toNumber(run.totalTax));
      acc.cam = round2(acc.cam + toNumber(run.totalCam));
      acc.net = round2(acc.net + toNumber(run.totalNet));
      acc.employeeCount += run.lines.length;
      return acc;
    },
    { gross: 0, cas: 0, cass: 0, tax: 0, cam: 0, net: 0, employeeCount: 0 },
  );

  const { year, month } = parseAnafPeriodParts(period.period);
  const declarant = splitDeclarantName(env.ANAF_DECLARANT_NAME);
  const companyCui = toAnafCuiForXsd(env.ANAF_COMPANY_CUI);
  const companyCaen = toAnafCaen(env.ANAF_COMPANY_CAEN);
  const companyName = normalizeText(env.ANAF_COMPANY_NAME, 'SEGA DEMO SRL', 200);

  const totalLiabilities = toAnafUnsignedInteger(totals.cas + totals.cass + totals.tax + totals.cam);
  const totalGross = toAnafUnsignedInteger(totals.gross);
  const employeeCount = Math.min(toAnafUnsignedInteger(totals.employeeCount), 99999);
  const totalCam = toAnafUnsignedInteger(totals.cam);
  const hasCam = totalCam > 0 ? 1 : 0;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<declaratieUnica xmlns="mfp:anaf:dgti:declaratie_unica:declaratie:v6" luna_r="${month}" an_r="${year}" nume_declar="${xmlEscape(normalizeText(declarant.lastName, 'Declarant', 75))}" prenume_declar="${xmlEscape(normalizeText(declarant.firstName, 'Declarant', 75))}" functie_declar="${xmlEscape(normalizeText(env.ANAF_DECLARANT_FUNCTION, 'Administrator', 50))}">`,
  );
  lines.push(
    `  <angajator cif="${xmlEscape(companyCui)}" caen="${xmlEscape(companyCaen)}" den="${xmlEscape(companyName)}" casaAng="AB" datCAM="${totalCam}" bifa_CAM="${hasCam}" totalPlata_A="${totalLiabilities}">`,
  );
  lines.push(
    `    <angajatorA A_codBugetar="20470101XX" A_codOblig="602" A_datorat="${totalLiabilities}" A_scutit="0" A_plata="${totalLiabilities}" />`,
  );
  lines.push(
    `    <angajatorB B_cnp="0" B_sanatate="0" B_pensie="0" B_brutSalarii="${totalGross}" B_sal="${employeeCount}" />`,
  );
  lines.push('  </angajator>');
  lines.push('</declaratieUnica>');

  return {
    type: 'd112',
    period: period.period,
    xml: lines.join('\n'),
    rowCount: runs.length,
  };
}

export async function buildD101Xml(companyId: string, period: AnafPeriod): Promise<AnafDeclarationPayload> {
  const year = parseAnafYear(period.period);
  const annualRange = buildAnnualRange(year);
  const declarant = splitDeclarantName(env.ANAF_DECLARANT_NAME);
  const companyCui = toAnafCuiForXsd(env.ANAF_COMPANY_CUI);
  const companyName = normalizeText(env.ANAF_COMPANY_NAME, 'SEGA DEMO SRL', 200);

  const [revenueAgg, expenseAgg, entryCount] = await Promise.all([
    prisma.journalLine.aggregate({
      _sum: { credit: true },
      where: {
        entry: {
          companyId,
          date: {
            gte: annualRange.start,
            lte: annualRange.end,
          },
        },
        account: {
          type: 'REVENUE',
        },
      },
    }),
    prisma.journalLine.aggregate({
      _sum: { debit: true },
      where: {
        entry: {
          companyId,
          date: {
            gte: annualRange.start,
            lte: annualRange.end,
          },
        },
        account: {
          type: 'EXPENSE',
        },
      },
    }),
    prisma.journalEntry.count({
      where: {
        companyId,
        date: {
          gte: annualRange.start,
          lte: annualRange.end,
        },
      },
    }),
  ]);

  const totalRevenue = round2(toNumber(revenueAgg._sum.credit));
  const totalExpense = round2(toNumber(expenseAgg._sum.debit));
  const accountingResult = round2(totalRevenue - totalExpense);
  const taxableProfit = round2(Math.max(accountingResult, 0));
  const corporateTax = round2(taxableProfit * 0.16);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<declaratie101 xmlns="mfp:anaf:dgti:d101:declaratie:v2" an="${year}" cui="${xmlEscape(companyCui)}" den="${xmlEscape(companyName)}" nume_declar="${xmlEscape(normalizeText(declarant.lastName, 'Declarant', 75))}" prenume_declar="${xmlEscape(normalizeText(declarant.firstName, 'Declarant', 75))}" functie_declar="${xmlEscape(normalizeText(env.ANAF_DECLARANT_FUNCTION, 'Administrator', 50))}">`,
  );
  lines.push(
    `  <sinteza venituri="${toAnafSignedInteger(totalRevenue)}" cheltuieli="${toAnafSignedInteger(totalExpense)}" profitContabil="${toAnafSignedInteger(accountingResult)}" profitImpozabil="${toAnafSignedInteger(taxableProfit)}" impozitProfit="${toAnafSignedInteger(corporateTax)}" />`,
  );
  lines.push('</declaratie101>');

  return {
    type: 'd101',
    period: period.period,
    xml: lines.join('\n'),
    rowCount: entryCount,
  };
}

export async function buildD100Xml(companyId: string, period: AnafPeriod): Promise<AnafDeclarationPayload> {
  const { year, month } = parseAnafPeriodParts(period.period);
  const quarter = quarterFromMonth(month);
  const companyCui = toAnafCuiForXsd(env.ANAF_COMPANY_CUI);
  const companyName = normalizeText(env.ANAF_COMPANY_NAME, 'SEGA DEMO SRL', 200);

  const invoiceAgg = await prisma.invoice.aggregate({
    _sum: { total: true },
    _count: { _all: true },
    where: {
      companyId,
      status: {
        not: InvoiceStatus.CANCELLED,
      },
      issueDate: {
        gte: period.start,
        lte: period.end,
      },
    },
  });

  const taxableBase = round2(toNumber(invoiceAgg._sum.total));
  const microTax1 = round2(taxableBase * 0.01);
  const microTax3 = round2(taxableBase * 0.03);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<declaratie100 xmlns="mfp:anaf:dgti:d100:declaratie:v2" an="${year}" trimestru="${quarter}" perioada="${xmlEscape(period.period)}" cui="${xmlEscape(companyCui)}" den="${xmlEscape(companyName)}">`,
  );
  lines.push(
    `  <obligatii bazaImpozabila="${toAnafSignedInteger(taxableBase)}" micro_1="${toAnafSignedInteger(microTax1)}" micro_3="${toAnafSignedInteger(microTax3)}" />`,
  );
  lines.push('</declaratie100>');

  return {
    type: 'd100',
    period: period.period,
    xml: lines.join('\n'),
    rowCount: invoiceAgg._count._all,
  };
}

export async function buildD205Xml(companyId: string, period: AnafPeriod): Promise<AnafDeclarationPayload> {
  const year = parseAnafYear(period.period);
  const annualRange = buildAnnualRange(year);
  const companyCui = toAnafCuiForXsd(env.ANAF_COMPANY_CUI);
  const companyName = normalizeText(env.ANAF_COMPANY_NAME, 'SEGA DEMO SRL', 200);

  const supplierPayments = await prisma.supplierPayment.findMany({
    where: {
      companyId,
      date: {
        gte: annualRange.start,
        lte: annualRange.end,
      },
    },
    include: {
      supplier: true,
    },
  });

  const totalPaid = round2(supplierPayments.reduce((sum, payment) => sum + toNumber(payment.amount), 0));
  const uniqueSuppliers = new Set(
    supplierPayments
      .map((payment) => payment.supplier?.id ?? payment.supplierId)
      .filter((supplierId): supplierId is string => Boolean(supplierId)),
  );
  const withheldTax = 0;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<declaratie205 xmlns="mfp:anaf:dgti:d205:declaratie:v2" an="${year}" cui="${xmlEscape(companyCui)}" den="${xmlEscape(companyName)}">`,
  );
  lines.push(
    `  <sumar nrBeneficiari="${toAnafUnsignedInteger(uniqueSuppliers.size)}" venitBrut="${toAnafSignedInteger(totalPaid)}" impozitRetinut="${toAnafSignedInteger(withheldTax)}" />`,
  );
  lines.push('</declaratie205>');

  return {
    type: 'd205',
    period: period.period,
    xml: lines.join('\n'),
    rowCount: supplierPayments.length,
  };
}

export async function buildD392Xml(companyId: string, period: AnafPeriod): Promise<AnafDeclarationPayload> {
  const year = parseAnafYear(period.period);
  const annualRange = buildAnnualRange(year);
  const companyCui = toAnafCuiForXsd(env.ANAF_COMPANY_CUI);
  const companyName = normalizeText(env.ANAF_COMPANY_NAME, 'SEGA DEMO SRL', 200);

  const supplierInvoices = await prisma.supplierInvoice.findMany({
    where: {
      companyId,
      status: {
        not: SupplierInvoiceStatus.CANCELLED,
      },
      receivedDate: {
        gte: annualRange.start,
        lte: annualRange.end,
      },
      supplier: {
        cui: {
          not: null,
        },
      },
    },
    include: {
      supplier: true,
    },
  });

  const intraEuInvoices = supplierInvoices.filter((invoice) => isNonRomanianCui(invoice.supplier.cui));
  const acquisitionsValue = round2(intraEuInvoices.reduce((sum, invoice) => sum + toNumber(invoice.total), 0));
  const underThreshold = acquisitionsValue < 10000;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<declaratie392 xmlns="mfp:anaf:dgti:d392:declaratie:v2" an="${year}" cui="${xmlEscape(companyCui)}" den="${xmlEscape(companyName)}" plafonEur="10000">`,
  );
  lines.push(
    `  <achizitiiIntracomunitare nrOperatiuni="${toAnafUnsignedInteger(intraEuInvoices.length)}" valoare="${toAnafSignedInteger(acquisitionsValue)}" subPlafon="${underThreshold ? 1 : 0}" />`,
  );
  lines.push('</declaratie392>');

  return {
    type: 'd392',
    period: period.period,
    xml: lines.join('\n'),
    rowCount: intraEuInvoices.length,
  };
}

export async function buildD393Xml(companyId: string, period: AnafPeriod): Promise<AnafDeclarationPayload> {
  const { year, month } = parseAnafPeriodParts(period.period);
  const companyCui = toAnafCuiForXsd(env.ANAF_COMPANY_CUI);
  const companyName = normalizeText(env.ANAF_COMPANY_NAME, 'SEGA DEMO SRL', 200);

  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      status: {
        not: InvoiceStatus.CANCELLED,
      },
      issueDate: {
        gte: period.start,
        lte: period.end,
      },
      partner: {
        cui: {
          not: null,
        },
      },
    },
    include: {
      partner: true,
    },
  });

  const intraEuDeliveries = invoices.filter((invoice) => isNonRomanianCui(invoice.partner.cui));
  const deliveryValue = round2(intraEuDeliveries.reduce((sum, invoice) => sum + toNumber(invoice.total), 0));
  const vatValue = round2(intraEuDeliveries.reduce((sum, invoice) => sum + toNumber(invoice.vat), 0));

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<declaratie393 xmlns="mfp:anaf:dgti:d393:declaratie:v2" an="${year}" luna="${month}" cui="${xmlEscape(companyCui)}" den="${xmlEscape(companyName)}">`,
  );
  lines.push(
    `  <livrariIntracomunitare nrOperatiuni="${toAnafUnsignedInteger(intraEuDeliveries.length)}" valoare="${toAnafSignedInteger(deliveryValue)}" tva="${toAnafSignedInteger(vatValue)}" />`,
  );
  lines.push('</declaratie393>');

  return {
    type: 'd393',
    period: period.period,
    xml: lines.join('\n'),
    rowCount: intraEuDeliveries.length,
  };
}

export async function buildD406Xml(companyId: string, period: AnafPeriod): Promise<AnafDeclarationPayload> {
  const companyCui = toAnafCuiForXsd(env.ANAF_COMPANY_CUI);
  const companyName = normalizeText(env.ANAF_COMPANY_NAME, 'SEGA DEMO SRL', 200);
  const generatedAt = new Date();
  const companyAddress = normalizeText(env.ANAF_COMPANY_ADDRESS, 'Bucuresti, Romania', 1000);

  const [accounts, partners, stockItems, assets, journalEntries, invoices, supplierInvoices] = await Promise.all([
    prisma.account.findMany({
      where: { companyId, isActive: true },
      orderBy: [{ code: 'asc' }],
    }),
    prisma.partner.findMany({
      where: { companyId },
      orderBy: [{ name: 'asc' }],
    }),
    prisma.stockItem.findMany({
      where: { companyId, isActive: true },
      orderBy: [{ code: 'asc' }],
    }),
    prisma.asset.findMany({
      where: { companyId, isActive: true },
      orderBy: [{ code: 'asc' }, { name: 'asc' }],
    }),
    prisma.journalEntry.findMany({
      where: {
        companyId,
        date: {
          gte: period.start,
          lte: period.end,
        },
      },
      include: {
        createdBy: {
          select: {
            email: true,
          },
        },
        lines: {
          include: {
            account: {
              select: {
                code: true,
                name: true,
              },
            },
          },
          orderBy: [{ id: 'asc' }],
        },
      },
      orderBy: [{ date: 'asc' }, { number: 'asc' }],
    }),
    prisma.invoice.findMany({
      where: {
        companyId,
        status: {
          not: InvoiceStatus.CANCELLED,
        },
        issueDate: {
          gte: period.start,
          lte: period.end,
        },
      },
      include: {
        partner: true,
      },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    }),
    prisma.supplierInvoice.findMany({
      where: {
        companyId,
        status: {
          not: SupplierInvoiceStatus.CANCELLED,
        },
        receivedDate: {
          gte: period.start,
          lte: period.end,
        },
      },
      include: {
        supplier: true,
      },
      orderBy: [{ receivedDate: 'asc' }, { number: 'asc' }],
    }),
  ]);

  const customers = partners.filter((partner) => partner.type === 'CUSTOMER' || partner.type === 'BOTH');
  const suppliers = partners.filter((partner) => partner.type === 'SUPPLIER' || partner.type === 'BOTH');

  const journalTransactions = journalEntries
    .map((entry) => {
      const lines = entry.lines.map((line) => {
        const debit = round2(toNumber(line.debit));
        const credit = round2(toNumber(line.credit));
        return {
          id: line.id,
          accountId: line.account.code,
          description: line.explanation ?? line.account.name ?? entry.description,
          debit,
          credit,
        };
      });

      if (lines.length === 0) {
        return null;
      }

      const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0);
      const totalCredit = lines.reduce((sum, line) => sum + line.credit, 0);

      return {
        id: entry.id,
        number: entry.number ?? `JE-${entry.id.slice(0, 8)}`,
        date: entry.date,
        month: entry.date.getUTCMonth() + 1,
        sourceId: entry.createdBy.email,
        description: entry.description,
        totalDebit,
        totalCredit,
        lines,
      };
    })
    .filter((entry): entry is Exclude<typeof entry, null> => Boolean(entry));

  const journalGroups = new Map<string, typeof journalTransactions>();
  for (const transaction of journalTransactions) {
    const key = `${transaction.date.getUTCFullYear()}-${String(transaction.date.getUTCMonth() + 1).padStart(2, '0')}`;
    const group = journalGroups.get(key) ?? [];
    group.push(transaction);
    journalGroups.set(key, group);
  }

  const ledgerTotals = journalTransactions.reduce(
    (acc, transaction) => {
      acc.debit = round2(acc.debit + transaction.totalDebit);
      acc.credit = round2(acc.credit + transaction.totalCredit);
      acc.lines += transaction.lines.length;
      return acc;
    },
    { debit: 0, credit: 0, lines: 0 },
  );

  const salesTotals = invoices.reduce(
    (acc, invoice) => {
      acc.net = round2(acc.net + toNumber(invoice.subtotal));
      acc.tax = round2(acc.tax + toNumber(invoice.vat));
      acc.gross = round2(acc.gross + toNumber(invoice.total));
      return acc;
    },
    { net: 0, tax: 0, gross: 0 },
  );

  const purchaseTotals = supplierInvoices.reduce(
    (acc, invoice) => {
      acc.net = round2(acc.net + toNumber(invoice.subtotal));
      acc.tax = round2(acc.tax + toNumber(invoice.vat));
      acc.gross = round2(acc.gross + toNumber(invoice.total));
      return acc;
    },
    { net: 0, tax: 0, gross: 0 },
  );

  const rowCount =
    accounts.length +
    customers.length +
    suppliers.length +
    stockItems.length +
    assets.length +
    journalTransactions.length +
    ledgerTotals.lines +
    invoices.length +
    supplierInvoices.length;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<AuditFile xmlns="urn:OECD:StandardAuditFile-Tax:RO">');
  lines.push('  <Header>');
  lines.push('    <AuditFileVersion>2.00</AuditFileVersion>');
  lines.push('    <AuditFileCountry>RO</AuditFileCountry>');
  lines.push(`    <CompanyID>${xmlEscape(companyCui)}</CompanyID>`);
  lines.push(`    <CompanyName>${xmlEscape(companyName)}</CompanyName>`);
  lines.push(`    <TaxRegistrationNumber>${xmlEscape(companyCui)}</TaxRegistrationNumber>`);
  lines.push(`    <StartDate>${toIsoDate(period.start)}</StartDate>`);
  lines.push(`    <EndDate>${toIsoDate(period.end)}</EndDate>`);
  lines.push(`    <DateCreated>${toIsoDate(generatedAt)}</DateCreated>`);
  lines.push('    <TaxAccountingBasis>A</TaxAccountingBasis>');
  lines.push('    <CurrencyCode>RON</CurrencyCode>');
  lines.push('    <ProductCompanyTaxID>SEGA</ProductCompanyTaxID>');
  lines.push('    <ProductID>SEGA Accounting</ProductID>');
  lines.push('    <ProductVersion>3.0</ProductVersion>');
  lines.push('  </Header>');
  lines.push('  <MasterFiles>');
  lines.push('    <GeneralLedgerAccounts>');
  for (const account of accounts) {
    lines.push('      <Account>');
    lines.push(`        <AccountID>${xmlEscape(account.code)}</AccountID>`);
    lines.push(`        <AccountDescription>${xmlEscape(normalizeText(account.name, account.code, 200))}</AccountDescription>`);
    lines.push(`        <AccountType>${xmlEscape(mapAccountTypeToSaftCode(account.type))}</AccountType>`);
    lines.push(`        <AccountCreationDate>${toIsoDate(account.createdAt)}</AccountCreationDate>`);
    lines.push('      </Account>');
  }
  lines.push('    </GeneralLedgerAccounts>');
  lines.push('    <Customers>');
  for (const customer of customers) {
    const customerTaxId = customer.cui?.trim();
    lines.push('      <Customer>');
    lines.push(`        <CustomerID>${xmlEscape(customer.id)}</CustomerID>`);
    lines.push('        <AccountID>4111</AccountID>');
    if (customerTaxId) {
      lines.push(`        <CustomerTaxID>${xmlEscape(customerTaxId)}</CustomerTaxID>`);
    }
    lines.push(`        <CompanyName>${xmlEscape(normalizeText(customer.name, customer.id, 200))}</CompanyName>`);
    lines.push(`        <BillingAddress>${xmlEscape(companyAddress)}</BillingAddress>`);
    lines.push('      </Customer>');
  }
  lines.push('    </Customers>');
  lines.push('    <Suppliers>');
  for (const supplier of suppliers) {
    const supplierTaxId = supplier.cui?.trim();
    lines.push('      <Supplier>');
    lines.push(`        <SupplierID>${xmlEscape(supplier.id)}</SupplierID>`);
    lines.push('        <AccountID>401</AccountID>');
    if (supplierTaxId) {
      lines.push(`        <SupplierTaxID>${xmlEscape(supplierTaxId)}</SupplierTaxID>`);
    }
    lines.push(`        <CompanyName>${xmlEscape(normalizeText(supplier.name, supplier.id, 200))}</CompanyName>`);
    lines.push(`        <BillingAddress>${xmlEscape(companyAddress)}</BillingAddress>`);
    lines.push('      </Supplier>');
  }
  lines.push('    </Suppliers>');
  lines.push('    <Products>');
  for (const product of stockItems) {
    lines.push('      <Product>');
    lines.push('        <ProductType>GOODS</ProductType>');
    lines.push(`        <ProductCode>${xmlEscape(product.code)}</ProductCode>`);
    lines.push(`        <ProductDescription>${xmlEscape(normalizeText(product.name, product.code, 200))}</ProductDescription>`);
    lines.push(`        <ProductNumberCode>${xmlEscape(product.unit)}</ProductNumberCode>`);
    lines.push('      </Product>');
  }
  lines.push('    </Products>');
  lines.push('    <Assets>');
  for (const asset of assets) {
    lines.push('      <Asset>');
    lines.push(`        <AssetID>${xmlEscape(asset.code ?? asset.id)}</AssetID>`);
    lines.push(`        <AssetDescription>${xmlEscape(normalizeText(asset.name, asset.id, 200))}</AssetDescription>`);
    lines.push(`        <AcquisitionDate>${toIsoDate(asset.startDate)}</AcquisitionDate>`);
    lines.push(`        <AssetType>${xmlEscape(asset.depreciationMethod)}</AssetType>`);
    lines.push(`        <OriginalAcquisitionValue>${toSaftAmount(toNumber(asset.value))}</OriginalAcquisitionValue>`);
    lines.push('      </Asset>');
  }
  lines.push('    </Assets>');
  lines.push('  </MasterFiles>');
  lines.push('  <GeneralLedgerEntries>');
  lines.push(`    <NumberOfEntries>${journalTransactions.length}</NumberOfEntries>`);
  lines.push(`    <TotalDebit>${toSaftAmount(ledgerTotals.debit)}</TotalDebit>`);
  lines.push(`    <TotalCredit>${toSaftAmount(ledgerTotals.credit)}</TotalCredit>`);
  for (const [journalKey, transactions] of journalGroups.entries()) {
    lines.push('    <Journal>');
    lines.push(`      <JournalID>JRN-${xmlEscape(journalKey)}</JournalID>`);
    lines.push('      <Description>Registru jurnal contabil</Description>');
    for (const transaction of transactions) {
      lines.push('      <Transaction>');
      lines.push(`        <TransactionID>${xmlEscape(transaction.number)}</TransactionID>`);
      lines.push(`        <Period>${transaction.month}</Period>`);
      lines.push(`        <TransactionDate>${toIsoDate(transaction.date)}</TransactionDate>`);
      lines.push(`        <SourceID>${xmlEscape(transaction.sourceId)}</SourceID>`);
      lines.push(`        <Description>${xmlEscape(normalizeText(transaction.description, transaction.id, 1000))}</Description>`);
      lines.push(`        <DocArchivalNumber>${xmlEscape(transaction.number)}</DocArchivalNumber>`);
      for (const transactionLine of transaction.lines) {
        lines.push('        <Line>');
        lines.push(`          <RecordID>${xmlEscape(transactionLine.id)}</RecordID>`);
        lines.push(`          <AccountID>${xmlEscape(transactionLine.accountId)}</AccountID>`);
        lines.push(
          `          <Description>${xmlEscape(normalizeText(transactionLine.description, transactionLine.id, 1000))}</Description>`,
        );
        lines.push(`          <DebitAmount>${toSaftAmount(transactionLine.debit)}</DebitAmount>`);
        lines.push(`          <CreditAmount>${toSaftAmount(transactionLine.credit)}</CreditAmount>`);
        lines.push('        </Line>');
      }
      lines.push('      </Transaction>');
    }
    lines.push('    </Journal>');
  }
  lines.push('  </GeneralLedgerEntries>');
  lines.push('  <SourceDocuments>');
  lines.push('    <SalesInvoices>');
  lines.push(`      <NumberOfEntries>${invoices.length}</NumberOfEntries>`);
  lines.push(`      <TotalDebit>${toSaftAmount(salesTotals.gross)}</TotalDebit>`);
  lines.push(`      <TotalCredit>${toSaftAmount(salesTotals.gross)}</TotalCredit>`);
  for (const invoice of invoices) {
    const invoiceType = mapSalesInvoiceTypeToSaftCode(invoice.kind);
    lines.push('      <Invoice>');
    lines.push(`        <InvoiceNo>${xmlEscape(invoice.number)}</InvoiceNo>`);
    lines.push(`        <InvoiceDate>${toIsoDate(invoice.issueDate)}</InvoiceDate>`);
    lines.push(`        <InvoiceType>${xmlEscape(invoiceType)}</InvoiceType>`);
    lines.push(`        <SourceID>${xmlEscape(invoice.partnerId)}</SourceID>`);
    lines.push(`        <SystemEntryDate>${toIsoDate(invoice.createdAt)}</SystemEntryDate>`);
    lines.push(`        <CustomerID>${xmlEscape(invoice.partnerId)}</CustomerID>`);
    lines.push('        <DocumentTotals>');
    lines.push(`          <TaxPayable>${toSaftAmount(toNumber(invoice.vat))}</TaxPayable>`);
    lines.push(`          <NetTotal>${toSaftAmount(toNumber(invoice.subtotal))}</NetTotal>`);
    lines.push(`          <GrossTotal>${toSaftAmount(toNumber(invoice.total))}</GrossTotal>`);
    lines.push('        </DocumentTotals>');
    lines.push('      </Invoice>');
  }
  lines.push('    </SalesInvoices>');
  lines.push('    <PurchaseInvoices>');
  lines.push(`      <NumberOfEntries>${supplierInvoices.length}</NumberOfEntries>`);
  lines.push(`      <TotalDebit>${toSaftAmount(purchaseTotals.gross)}</TotalDebit>`);
  lines.push(`      <TotalCredit>${toSaftAmount(purchaseTotals.gross)}</TotalCredit>`);
  for (const supplierInvoice of supplierInvoices) {
    lines.push('      <Invoice>');
    lines.push(`        <InvoiceNo>${xmlEscape(supplierInvoice.number)}</InvoiceNo>`);
    lines.push(`        <InvoiceDate>${toIsoDate(supplierInvoice.receivedDate)}</InvoiceDate>`);
    lines.push('        <InvoiceType>PI</InvoiceType>');
    lines.push(`        <SourceID>${xmlEscape(supplierInvoice.supplierId)}</SourceID>`);
    lines.push(`        <SystemEntryDate>${toIsoDate(supplierInvoice.createdAt)}</SystemEntryDate>`);
    lines.push(`        <SupplierID>${xmlEscape(supplierInvoice.supplierId)}</SupplierID>`);
    lines.push('        <DocumentTotals>');
    lines.push(`          <TaxPayable>${toSaftAmount(toNumber(supplierInvoice.vat))}</TaxPayable>`);
    lines.push(`          <NetTotal>${toSaftAmount(toNumber(supplierInvoice.subtotal))}</NetTotal>`);
    lines.push(`          <GrossTotal>${toSaftAmount(toNumber(supplierInvoice.total))}</GrossTotal>`);
    lines.push('        </DocumentTotals>');
    lines.push('      </Invoice>');
  }
  lines.push('    </PurchaseInvoices>');
  lines.push('  </SourceDocuments>');
  lines.push('</AuditFile>');

  return {
    type: 'd406',
    period: period.period,
    xml: lines.join('\n'),
    rowCount,
  };
}

export async function buildD406ConformityReport(companyId: string, period: AnafPeriod): Promise<D406ConformityReport> {
  const [accounts, partners, stockItems, assets, journalEntries, invoices, supplierInvoices] = await Promise.all([
    prisma.account.findMany({
      where: { companyId, isActive: true },
      select: {
        code: true,
        name: true,
        type: true,
      },
    }),
    prisma.partner.findMany({
      where: { companyId },
      select: {
        id: true,
        name: true,
        cui: true,
        type: true,
      },
    }),
    prisma.stockItem.findMany({
      where: { companyId, isActive: true },
      select: {
        code: true,
        name: true,
      },
    }),
    prisma.asset.findMany({
      where: { companyId, isActive: true },
      select: {
        code: true,
        name: true,
      },
    }),
    prisma.journalEntry.findMany({
      where: {
        companyId,
        date: {
          gte: period.start,
          lte: period.end,
        },
      },
      select: {
        number: true,
        lines: {
          select: {
            accountId: true,
          },
        },
      },
    }),
    prisma.invoice.findMany({
      where: {
        companyId,
        status: {
          not: InvoiceStatus.CANCELLED,
        },
        issueDate: {
          gte: period.start,
          lte: period.end,
        },
      },
      select: {
        number: true,
        kind: true,
        partnerId: true,
        partner: {
          select: {
            cui: true,
          },
        },
      },
    }),
    prisma.supplierInvoice.findMany({
      where: {
        companyId,
        status: {
          not: SupplierInvoiceStatus.CANCELLED,
        },
        receivedDate: {
          gte: period.start,
          lte: period.end,
        },
      },
      select: {
        number: true,
        supplierId: true,
        supplier: {
          select: {
            cui: true,
          },
        },
      },
    }),
  ]);

  const customers = partners.filter((partner) => partner.type === 'CUSTOMER' || partner.type === 'BOTH');
  const suppliers = partners.filter((partner) => partner.type === 'SUPPLIER' || partner.type === 'BOTH');

  const journalLines = journalEntries.flatMap((entry) => entry.lines);

  const missing = {
    accountsWithoutCode: accounts.filter((account) => account.code.trim().length === 0).length,
    accountsWithoutName: accounts.filter((account) => account.name.trim().length === 0).length,
    customersWithoutName: customers.filter((partner) => partner.name.trim().length === 0).length,
    customersWithoutTaxId: customers.filter((partner) => !partner.cui || partner.cui.trim().length === 0).length,
    suppliersWithoutName: suppliers.filter((partner) => partner.name.trim().length === 0).length,
    suppliersWithoutTaxId: suppliers.filter((partner) => !partner.cui || partner.cui.trim().length === 0).length,
    productsWithoutCode: stockItems.filter((product) => product.code.trim().length === 0).length,
    productsWithoutName: stockItems.filter((product) => product.name.trim().length === 0).length,
    assetsWithoutCode: assets.filter((asset) => !asset.code || asset.code.trim().length === 0).length,
    assetsWithoutName: assets.filter((asset) => asset.name.trim().length === 0).length,
    journalEntriesWithoutNumber: journalEntries.filter((entry) => !entry.number || entry.number.trim().length === 0).length,
    journalEntriesWithoutLines: journalEntries.filter((entry) => entry.lines.length === 0).length,
    journalLinesWithoutAccount: journalLines.filter((line) => line.accountId.trim().length === 0).length,
    salesInvoicesWithoutPartner: invoices.filter((invoice) => invoice.partnerId.trim().length === 0).length,
    salesInvoicesWithoutNumber: invoices.filter((invoice) => invoice.number.trim().length === 0).length,
    salesInvoicesWithoutCustomerTaxId: invoices.filter((invoice) => !invoice.partner?.cui || invoice.partner.cui.trim().length === 0)
      .length,
    purchaseInvoicesWithoutSupplier: supplierInvoices.filter((invoice) => invoice.supplierId.trim().length === 0).length,
    purchaseInvoicesWithoutNumber: supplierInvoices.filter((invoice) => invoice.number.trim().length === 0).length,
    purchaseInvoicesWithoutSupplierTaxId: supplierInvoices.filter(
      (invoice) => !invoice.supplier?.cui || invoice.supplier.cui.trim().length === 0,
    ).length,
  };

  const blockingChecks: Array<{ label: string; value: number }> = [
    { label: 'accountsWithoutCode', value: missing.accountsWithoutCode },
    { label: 'accountsWithoutName', value: missing.accountsWithoutName },
    { label: 'customersWithoutName', value: missing.customersWithoutName },
    { label: 'suppliersWithoutName', value: missing.suppliersWithoutName },
    { label: 'productsWithoutCode', value: missing.productsWithoutCode },
    { label: 'productsWithoutName', value: missing.productsWithoutName },
    { label: 'assetsWithoutName', value: missing.assetsWithoutName },
    { label: 'journalEntriesWithoutLines', value: missing.journalEntriesWithoutLines },
    { label: 'journalLinesWithoutAccount', value: missing.journalLinesWithoutAccount },
    { label: 'salesInvoicesWithoutPartner', value: missing.salesInvoicesWithoutPartner },
    { label: 'salesInvoicesWithoutNumber', value: missing.salesInvoicesWithoutNumber },
    { label: 'purchaseInvoicesWithoutSupplier', value: missing.purchaseInvoicesWithoutSupplier },
    { label: 'purchaseInvoicesWithoutNumber', value: missing.purchaseInvoicesWithoutNumber },
  ];

  const warningChecks: Array<{ label: string; value: number }> = [
    { label: 'customersWithoutTaxId', value: missing.customersWithoutTaxId },
    { label: 'suppliersWithoutTaxId', value: missing.suppliersWithoutTaxId },
    { label: 'assetsWithoutCode', value: missing.assetsWithoutCode },
    { label: 'journalEntriesWithoutNumber', value: missing.journalEntriesWithoutNumber },
    { label: 'salesInvoicesWithoutCustomerTaxId', value: missing.salesInvoicesWithoutCustomerTaxId },
    { label: 'purchaseInvoicesWithoutSupplierTaxId', value: missing.purchaseInvoicesWithoutSupplierTaxId },
  ];

  const blockingIssues = blockingChecks
    .filter((check) => check.value > 0)
    .map((check) => `${check.label}: ${check.value}`);
  const warnings = warningChecks.filter((check) => check.value > 0).map((check) => `${check.label}: ${check.value}`);

  const totals = {
    accounts: accounts.length,
    customers: customers.length,
    suppliers: suppliers.length,
    products: stockItems.length,
    assets: assets.length,
    journalEntries: journalEntries.length,
    journalLines: journalLines.length,
    salesInvoices: invoices.length,
    purchaseInvoices: supplierInvoices.length,
  };

  const denominator = Math.max(
    1,
    totals.accounts +
      totals.customers +
      totals.suppliers +
      totals.products +
      totals.assets +
      totals.journalEntries +
      totals.journalLines +
      totals.salesInvoices +
      totals.purchaseInvoices,
  );
  const weightedMissing =
    blockingChecks.reduce((sum, check) => sum + check.value * 2, 0) + warningChecks.reduce((sum, check) => sum + check.value, 0);
  const score = Math.max(0, Math.min(100, Math.round((1 - weightedMissing / denominator) * 100)));

  return {
    declaration: 'D406',
    period: period.period,
    generatedAt: new Date().toISOString(),
    score,
    totals,
    missing,
    mappings: {
      accountTypeCodes: sortUnique(accounts.map((account) => mapAccountTypeToSaftCode(account.type))),
      salesInvoiceTypes: sortUnique(invoices.map((invoice) => mapSalesInvoiceTypeToSaftCode(invoice.kind))),
      purchaseInvoiceTypes: supplierInvoices.length > 0 ? ['PI'] : [],
    },
    blockingIssues,
    warnings,
  };
}

export async function validateAnafPayload(
  payload: AnafDeclarationPayload,
  validateRequested: boolean,
): Promise<AnafValidationSummary> {
  const profile = validateAnafProfile(payload.type, {
    period: payload.period,
    rowCount: payload.rowCount,
  });
  const xsd = await validateXmlWithXsd(payload.type, payload.xml, validateRequested);

  return {
    declaration: declarationCode(payload.type),
    period: payload.period,
    profile,
    xsd,
  };
}

export async function buildAnafDeclarationXml(
  type: AnafDeclarationType,
  companyId: string,
  period: AnafPeriod,
): Promise<AnafDeclarationPayload> {
  switch (type) {
    case 'd300':
      return buildD300Xml(companyId, period);
    case 'd394':
      return buildD394Xml(companyId, period);
    case 'd112':
      return buildD112Xml(companyId, period);
    case 'd101':
      return buildD101Xml(companyId, period);
    case 'd100':
      return buildD100Xml(companyId, period);
    case 'd205':
      return buildD205Xml(companyId, period);
    case 'd392':
      return buildD392Xml(companyId, period);
    case 'd393':
      return buildD393Xml(companyId, period);
    case 'd406':
      return buildD406Xml(companyId, period);
    default:
      return buildD112Xml(companyId, period);
  }
}

export function hasAnafBlockingErrors(
  validation: AnafValidationSummary,
  options?: { requireXsdPerformed?: boolean },
): boolean {
  if (!validation.profile.valid) {
    return true;
  }

  if (options?.requireXsdPerformed && !validation.xsd.performed) {
    return true;
  }

  return validation.xsd.performed && validation.xsd.valid === false;
}
