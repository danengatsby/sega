import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { formatAmount, xmlEscape } from './helpers.js';
import type { FinancialStatementBundle } from './types.js';

const execFileAsync = promisify(execFile);

const XBRL_INSTANCE_NS = 'http://www.xbrl.org/2003/instance';
const XBRL_ISO4217_NS = 'http://www.xbrl.org/2003/iso4217';
const SEGA_XBRL_NS = 'http://sega.local/xbrl/financial/2026';

const XBRL_INSTANCE_SCHEMA_FILE = 'sega-xbrl-instance.xsd';
const XBRL_TAXONOMY_SCHEMA_FILE = 'sega-financial-statements-2026.xsd';

export interface XbrlXsdValidationResult {
  performed: boolean;
  valid: boolean | null;
  validator: 'xmllint' | 'none';
  schemaPath: string | null;
  errors: string[];
  warnings: string[];
}

interface BuildXbrlContentOptions {
  year: number;
  entityIdentifier: string;
}

interface MonetaryFact {
  name: string;
  value: number;
}

function buildMonetaryFacts(bundle: FinancialStatementBundle): MonetaryFact[] {
  return [
    { name: 'TrialBalanceDebitTotal', value: bundle.trialBalance.totals.debit },
    { name: 'TrialBalanceCreditTotal', value: bundle.trialBalance.totals.credit },
    { name: 'Revenues', value: bundle.pnl.revenues },
    { name: 'Expenses', value: bundle.pnl.expenses },
    { name: 'NetProfit', value: bundle.pnl.netProfit },
    { name: 'Assets', value: bundle.balanceSheet.assets },
    { name: 'Liabilities', value: bundle.balanceSheet.liabilities },
    { name: 'Equity', value: bundle.balanceSheet.equity },
    { name: 'LiabilitiesAndEquity', value: bundle.balanceSheet.liabilitiesAndEquity },
    { name: 'TaxableSales', value: bundle.taxSummary.taxableSales },
    { name: 'VatCollected', value: bundle.taxSummary.vatCollected },
    { name: 'PayrollCas', value: bundle.taxSummary.payrollCas },
    { name: 'PayrollCass', value: bundle.taxSummary.payrollCass },
    { name: 'PayrollCam', value: bundle.taxSummary.payrollCam },
    { name: 'PayrollTax', value: bundle.taxSummary.payrollTax },
    { name: 'EstimatedProfitTax', value: bundle.taxSummary.estimatedProfitTax },
    { name: 'TotalFiscalLiabilities', value: bundle.taxSummary.totalFiscalLiabilities },
  ];
}

export function buildXbrlContent(bundle: FinancialStatementBundle, options: BuildXbrlContentOptions): string {
  const yearStart = `${options.year}-01-01`;
  const yearEnd = `${options.year}-12-31`;
  const contextId = `CTX-${options.year}`;
  const unitId = 'U-RON';
  const facts = buildMonetaryFacts(bundle);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<xbrli:xbrl xmlns:xbrli="${XBRL_INSTANCE_NS}" xmlns:sega="${SEGA_XBRL_NS}" xmlns:iso4217="${XBRL_ISO4217_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${XBRL_INSTANCE_NS} ${XBRL_INSTANCE_SCHEMA_FILE} ${SEGA_XBRL_NS} ${XBRL_TAXONOMY_SCHEMA_FILE}">`,
  );
  lines.push(`  <xbrli:context id="${contextId}">`);
  lines.push('    <xbrli:entity>');
  lines.push(`      <xbrli:identifier scheme="urn:sega:company-id">${xmlEscape(options.entityIdentifier)}</xbrli:identifier>`);
  lines.push('    </xbrli:entity>');
  lines.push('    <xbrli:period>');
  lines.push(`      <xbrli:startDate>${yearStart}</xbrli:startDate>`);
  lines.push(`      <xbrli:endDate>${yearEnd}</xbrli:endDate>`);
  lines.push('    </xbrli:period>');
  lines.push('  </xbrli:context>');
  lines.push(`  <xbrli:unit id="${unitId}">`);
  lines.push('    <xbrli:measure>iso4217:RON</xbrli:measure>');
  lines.push('  </xbrli:unit>');

  for (const fact of facts) {
    lines.push(
      `  <sega:${fact.name} contextRef="${contextId}" unitRef="${unitId}" decimals="2">${formatAmount(fact.value)}</sega:${fact.name}>`,
    );
  }

  lines.push('</xbrli:xbrl>');
  return lines.join('\n');
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-lc', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveXbrlSchemaPath(): Promise<string> {
  const serviceDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultSchemaPath = path.resolve(process.cwd(), 'xbrl/xsd', XBRL_INSTANCE_SCHEMA_FILE);
  const candidates = [defaultSchemaPath, path.resolve(serviceDir, '../../../xbrl/xsd', XBRL_INSTANCE_SCHEMA_FILE)];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? defaultSchemaPath;
}

export async function validateXbrlWithSchema(xml: string, requested: boolean): Promise<XbrlXsdValidationResult> {
  if (!requested) {
    return {
      performed: false,
      valid: null,
      validator: 'none',
      schemaPath: null,
      errors: [],
      warnings: ['Validarea XBRL XSD este dezactivată (validate=false).'],
    };
  }

  const schemaPath = await resolveXbrlSchemaPath();

  if (!(await fileExists(schemaPath))) {
    return {
      performed: false,
      valid: null,
      validator: 'none',
      schemaPath,
      errors: [],
      warnings: [`Schema XBRL lipsește: ${schemaPath}`],
    };
  }

  const hasXmllint = await commandExists('xmllint');
  if (!hasXmllint) {
    return {
      performed: false,
      valid: null,
      validator: 'none',
      schemaPath,
      errors: [],
      warnings: ['Comanda xmllint nu este disponibilă.'],
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sega-xbrl-'));
  const xmlPath = path.join(tempDir, 'financial-statements.xbrl');

  try {
    await fs.writeFile(xmlPath, xml, 'utf8');

    try {
      await execFileAsync('xmllint', ['--noout', '--schema', schemaPath, xmlPath]);
      return {
        performed: true,
        valid: true,
        validator: 'xmllint',
        schemaPath,
        errors: [],
        warnings: [],
      };
    } catch (error) {
      const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
      const parsedErrors = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      return {
        performed: true,
        valid: false,
        validator: 'xmllint',
        schemaPath,
        errors: parsedErrors.length > 0 ? parsedErrors : ['Validarea XBRL XSD a eșuat fără detalii.'],
        warnings: [],
      };
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
