import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { toNumber } from '../utils/number.js';
import { periodToDateRange } from '../utils/period.js';
import { bareCui } from '../utils/anaf.js';
import { xmlEscape } from './reports/helpers.js';

const execFileAsync = promisify(execFile);

const REVISAL_ALLOWED_CONTRACT_TYPES = new Set(['CIM', 'CIP', 'CONVENTIE', 'MANDAT', 'OTHER']);

interface RevisalEmployeeSnapshot {
  id: string;
  cnp: string;
  name: string;
  contractType: string;
  grossSalary: number;
  hiredAt: Date;
  isActive: boolean;
}

interface RevisalContractRow {
  employeeId: string;
  cnp: string;
  fullName: string;
  contractType: 'CIM' | 'CIP' | 'CONVENTIE' | 'MANDAT' | 'OTHER';
  startDate: Date;
  endDate?: Date;
  baseSalary: number;
  status: 'ACTIVE' | 'INACTIVE';
  operation: 'HIRE' | 'UPDATE' | 'TERMINATION';
}

export interface RevisalXsdValidationResult {
  performed: boolean;
  valid: boolean | null;
  validator: 'xmllint' | 'none';
  schemaPath: string | null;
  errors: string[];
  warnings: string[];
}

export interface RevisalExportResult {
  xml: string;
  xmlChecksum: string;
  employeeCount: number;
  activeEmployeeCount: number;
  inactiveEmployeeCount: number;
  blockingErrors: string[];
  warnings: string[];
  xsdValidation: RevisalXsdValidationResult;
}

function normalizeContractType(raw: string): RevisalContractRow['contractType'] {
  const normalized = raw.trim().toUpperCase().replace(/\s+/g, '_');
  if (REVISAL_ALLOWED_CONTRACT_TYPES.has(normalized)) {
    return normalized as RevisalContractRow['contractType'];
  }
  if (normalized === 'CIVIL' || normalized === 'CONTRACT_CIVIL') {
    return 'CONVENTIE';
  }
  return 'OTHER';
}

function mapOperation(employee: RevisalEmployeeSnapshot, periodStart: Date): RevisalContractRow['operation'] {
  if (!employee.isActive) {
    return 'TERMINATION';
  }
  if (employee.hiredAt >= periodStart) {
    return 'HIRE';
  }
  return 'UPDATE';
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toIsoDateTime(value: Date): string {
  return value.toISOString();
}

function toMoney(value: number): string {
  return value.toFixed(2);
}

function computeSha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function cleanAndNormalizeCompanyCui(raw: string): string {
  const digits = bareCui(raw).replace(/\D+/g, '');
  if (/^[1-9]\d{1,12}$/.test(digits)) {
    return digits;
  }
  return '12345678';
}

function buildContractRows(
  employees: RevisalEmployeeSnapshot[],
  periodStart: Date,
  periodEnd: Date,
): { rows: RevisalContractRow[]; blockingErrors: string[]; warnings: string[] } {
  const blockingErrors: string[] = [];
  const warnings: string[] = [];
  const rows: RevisalContractRow[] = [];

  for (const employee of employees) {
    const cnp = employee.cnp.trim();
    const fullName = employee.name.trim();
    const baseSalary = toNumber(employee.grossSalary);

    if (!/^[1-9]\d{12}$/.test(cnp)) {
      blockingErrors.push(`Angajat ${employee.id}: CNP invalid (${employee.cnp}).`);
    }

    if (fullName.length < 3) {
      blockingErrors.push(`Angajat ${employee.id}: nume invalid.`);
    }

    if (!Number.isFinite(baseSalary) || baseSalary <= 0) {
      blockingErrors.push(`Angajat ${employee.id}: salariu brut invalid (${employee.grossSalary}).`);
    }

    if (employee.hiredAt > periodEnd) {
      warnings.push(`Angajat ${employee.id}: data angajării este după perioada exportată și a fost exclus.`);
      continue;
    }

    const row: RevisalContractRow = {
      employeeId: employee.id,
      cnp,
      fullName,
      contractType: normalizeContractType(employee.contractType),
      startDate: employee.hiredAt,
      endDate: employee.isActive ? undefined : periodEnd,
      baseSalary,
      status: employee.isActive ? 'ACTIVE' : 'INACTIVE',
      operation: mapOperation(employee, periodStart),
    };

    if (row.contractType === 'OTHER') {
      warnings.push(`Angajat ${employee.id}: contractType ${employee.contractType} mapat la OTHER.`);
    }

    rows.push(row);
  }

  return {
    rows: rows.sort((left, right) => left.fullName.localeCompare(right.fullName)),
    blockingErrors,
    warnings,
  };
}

function buildRevisalXml(input: {
  period: string;
  companyCui: string;
  companyName: string;
  companyAddress: string;
  deliveryReference: string;
  generatedAt: Date;
  contracts: RevisalContractRow[];
}): string {
  const activeCount = input.contracts.filter((contract) => contract.status === 'ACTIVE').length;
  const inactiveCount = input.contracts.length - activeCount;

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<RevisalExport xmlns="urn:ro:itm:revisal:1.0">');
  lines.push('  <Header>');
  lines.push('    <Application>SEGA Accounting</Application>');
  lines.push('    <ExportVersion>1.0</ExportVersion>');
  lines.push(`    <GeneratedAt>${toIsoDateTime(input.generatedAt)}</GeneratedAt>`);
  lines.push(`    <Period>${xmlEscape(input.period)}</Period>`);
  lines.push(`    <DeliveryReference>${xmlEscape(input.deliveryReference)}</DeliveryReference>`);
  lines.push('    <Company>');
  lines.push(`      <Cui>${xmlEscape(input.companyCui)}</Cui>`);
  lines.push(`      <Name>${xmlEscape(input.companyName)}</Name>`);
  lines.push(`      <Address>${xmlEscape(input.companyAddress)}</Address>`);
  lines.push('    </Company>');
  lines.push('  </Header>');
  lines.push('  <Summary>');
  lines.push(`    <TotalContracts>${input.contracts.length}</TotalContracts>`);
  lines.push(`    <ActiveContracts>${activeCount}</ActiveContracts>`);
  lines.push(`    <InactiveContracts>${inactiveCount}</InactiveContracts>`);
  lines.push('  </Summary>');
  lines.push('  <Contracts>');

  for (const contract of input.contracts) {
    lines.push('    <Contract>');
    lines.push(`      <EmployeeId>${xmlEscape(contract.employeeId)}</EmployeeId>`);
    lines.push(`      <Cnp>${xmlEscape(contract.cnp)}</Cnp>`);
    lines.push(`      <FullName>${xmlEscape(contract.fullName)}</FullName>`);
    lines.push(`      <ContractType>${contract.contractType}</ContractType>`);
    lines.push(`      <StartDate>${toIsoDate(contract.startDate)}</StartDate>`);
    if (contract.endDate) {
      lines.push(`      <EndDate>${toIsoDate(contract.endDate)}</EndDate>`);
    }
    lines.push(`      <BaseSalary>${toMoney(contract.baseSalary)}</BaseSalary>`);
    lines.push(`      <Status>${contract.status}</Status>`);
    lines.push(`      <Operation>${contract.operation}</Operation>`);
    lines.push('    </Contract>');
  }

  lines.push('  </Contracts>');
  lines.push('</RevisalExport>');
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

async function resolveRevisalSchemaPath(): Promise<string> {
  const serviceDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultSchemaPath = path.resolve(process.cwd(), 'revisal/xsd/revisal-export.xsd');
  const candidates = [
    defaultSchemaPath,
    path.resolve(serviceDir, '../../revisal/xsd/revisal-export.xsd'),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return candidates[0] ?? defaultSchemaPath;
}

async function validateRevisalXmlWithXsd(xml: string): Promise<RevisalXsdValidationResult> {
  const schemaPath = await resolveRevisalSchemaPath();

  if (!(await fileExists(schemaPath))) {
    return {
      performed: false,
      valid: null,
      validator: 'none',
      schemaPath,
      errors: [],
      warnings: [`Schema Revisal lipsește: ${schemaPath}`],
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

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sega-revisal-'));
  const xmlPath = path.join(tempDir, 'revisal.xml');

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
        errors: parsedErrors.length > 0 ? parsedErrors : ['Validarea Revisal XSD a eșuat fără detalii.'],
        warnings: [],
      };
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildRevisalExport(companyId: string, period: string, deliveryReference: string): Promise<RevisalExportResult> {
  const { start, end } = periodToDateRange(period);
  const generatedAt = new Date();

  const [employees, company] = await Promise.all([
    prisma.employee.findMany({
      where: {
        companyId,
        hiredAt: {
          lte: end,
        },
      },
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        cnp: true,
        name: true,
        contractType: true,
        grossSalary: true,
        hiredAt: true,
        isActive: true,
      },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: {
        name: true,
        cui: true,
      },
    }),
  ]);

  const dbCompanyName = company?.name?.trim();
  const envCompanyName = env.ANAF_COMPANY_NAME.trim();
  const companyName =
    dbCompanyName && dbCompanyName.length > 0
      ? dbCompanyName
      : envCompanyName.length > 0
        ? envCompanyName
        : 'SEGA DEMO SRL';
  const companyAddress = env.ANAF_COMPANY_ADDRESS.trim().length > 0 ? env.ANAF_COMPANY_ADDRESS.trim() : 'Bucuresti, Romania';
  const companyCui = cleanAndNormalizeCompanyCui(company?.cui ?? env.ANAF_COMPANY_CUI);

  const employeeSnapshots: RevisalEmployeeSnapshot[] = employees.map((employee) => ({
    ...employee,
    grossSalary: toNumber(employee.grossSalary),
  }));

  const buildResult = buildContractRows(employeeSnapshots, start, end);
  if (employees.length === 0) {
    buildResult.warnings.push(`Nu există angajați eligibili pentru perioada ${period}.`);
  }

  const xml = buildRevisalXml({
    period,
    companyCui,
    companyName,
    companyAddress,
    deliveryReference,
    generatedAt,
    contracts: buildResult.rows,
  });
  const xmlChecksum = computeSha256Hex(xml);
  const xsdValidation = await validateRevisalXmlWithXsd(xml);

  const blockingErrors = [...buildResult.blockingErrors];
  if (xsdValidation.performed && xsdValidation.valid === false) {
    blockingErrors.push(...xsdValidation.errors);
  }

  const warnings = [...buildResult.warnings, ...xsdValidation.warnings];

  const activeEmployeeCount = buildResult.rows.filter((row) => row.status === 'ACTIVE').length;
  const inactiveEmployeeCount = buildResult.rows.length - activeEmployeeCount;

  return {
    xml,
    xmlChecksum,
    employeeCount: buildResult.rows.length,
    activeEmployeeCount,
    inactiveEmployeeCount,
    blockingErrors,
    warnings,
    xsdValidation,
  };
}
