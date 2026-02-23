import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { prisma } from '../../src/lib/prisma.js';

interface CliArgs {
  period?: string;
  companyId?: string;
  output?: string;
  npsScore?: string;
  npsRespondents?: string;
}

interface PeriodRange {
  period: string;
  start: Date;
  end: Date;
}

interface MetricRow {
  metric: string;
  target: string;
  actual: string;
  status: 'PASS' | 'FAIL' | 'N/A';
  notes: string;
}

type SqlScalar = string | number | bigint | null | { toString(): string };

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (const token of argv) {
    if (!token.startsWith('--')) {
      continue;
    }

    const [rawKey, ...rest] = token.slice(2).split('=');
    const value = rest.join('=').trim();
    if (!rawKey || !value) {
      continue;
    }

    if (rawKey === 'period') {
      args.period = value;
    } else if (rawKey === 'company-id') {
      args.companyId = value;
    } else if (rawKey === 'output') {
      args.output = value;
    } else if (rawKey === 'nps-score') {
      args.npsScore = value;
    } else if (rawKey === 'nps-respondents') {
      args.npsRespondents = value;
    }
  }

  return args;
}

function toNumber(value: SqlScalar, fallback = 0): number {
  if (value === null) {
    return fallback;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function resolvePeriod(periodInput?: string): PeriodRange {
  const source = periodInput?.trim();
  const effective = source && source.length > 0 ? source : previousMonthPeriod();

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(effective)) {
    throw new Error(`Invalid period '${effective}'. Expected YYYY-MM.`);
  }

  const [yearRaw, monthRaw] = effective.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));

  return {
    period: effective,
    start,
    end,
  };
}

function previousMonthPeriod(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const base = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resolveOutputPath(period: string, outputArg?: string): string {
  const candidate = outputArg?.trim();
  if (candidate) {
    return resolve(process.cwd(), candidate);
  }

  return resolve(process.cwd(), `../../docs/reports/kpi-business-report-${period}.md`);
}

function toPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function toDays(value: number): string {
  return `${value.toFixed(2)} days`;
}

function evaluateHigherIsBetter(actual: number, target: number): 'PASS' | 'FAIL' {
  return actual >= target ? 'PASS' : 'FAIL';
}

function evaluateLowerIsBetter(actual: number, target: number): 'PASS' | 'FAIL' {
  return actual <= target ? 'PASS' : 'FAIL';
}

function evaluateEquals(actual: number, target: number): 'PASS' | 'FAIL' {
  return actual === target ? 'PASS' : 'FAIL';
}

async function run(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const periodRange = resolvePeriod(cli.period ?? process.env.KPI_REPORT_PERIOD);
  const companyId = cli.companyId ?? process.env.KPI_REPORT_COMPANY_ID;

  if (!companyId) {
    throw new Error('Missing company id. Set --company-id=... or KPI_REPORT_COMPANY_ID.');
  }

  const outputPath = resolveOutputPath(periodRange.period, cli.output ?? process.env.KPI_REPORT_OUTPUT);
  const npsScore = parseOptionalNumber(cli.npsScore ?? process.env.KPI_REPORT_NPS_SCORE);
  const npsRespondents = parseOptionalNumber(cli.npsRespondents ?? process.env.KPI_REPORT_NPS_RESPONDENTS);

  const [manualStats] = await prisma.$queryRaw<
    Array<{
      total_entries: SqlScalar;
      manual_entries: SqlScalar;
    }>
  >`
    SELECT
      COUNT(*)::int AS total_entries,
      COUNT(*) FILTER (WHERE "sourceModule" = 'MANUAL' OR "sourceModule" IS NULL)::int AS manual_entries
    FROM public."JournalEntry"
    WHERE "companyId" = ${companyId}::uuid
      AND date >= ${periodRange.start}
      AND date < ${periodRange.end};
  `;

  const totalEntries = toNumber(manualStats?.total_entries);
  const manualEntries = toNumber(manualStats?.manual_entries);
  const automationReductionPct = totalEntries > 0 ? 100 * (1 - manualEntries / totalEntries) : 0;

  const [efacturaStats] = await prisma.$queryRaw<
    Array<{
      total_fiscal: SqlScalar;
      submitted_on_time: SqlScalar;
    }>
  >`
    SELECT
      COUNT(*) FILTER (WHERE kind = 'FISCAL')::int AS total_fiscal,
      COUNT(*) FILTER (
        WHERE kind = 'FISCAL'
          AND "efacturaSubmittedAt" IS NOT NULL
          AND "efacturaSubmittedAt" <= ("issueDate" + interval '5 day')
      )::int AS submitted_on_time
    FROM public."Invoice"
    WHERE "companyId" = ${companyId}::uuid
      AND "issueDate" >= ${periodRange.start}
      AND "issueDate" < ${periodRange.end};
  `;

  const totalFiscal = toNumber(efacturaStats?.total_fiscal);
  const submittedOnTime = toNumber(efacturaStats?.submitted_on_time);
  const efacturaOnTimePct = totalFiscal > 0 ? (submittedOnTime / totalFiscal) * 100 : 0;

  const [membershipStats] = await prisma.$queryRaw<
    Array<{
      total_members: SqlScalar;
    }>
  >`
    SELECT COUNT(DISTINCT "userId")::int AS total_members
    FROM public."UserCompanyMembership"
    WHERE "companyId" = ${companyId}::uuid;
  `;

  const [activityStats] = await prisma.$queryRaw<
    Array<{
      active_users: SqlScalar;
    }>
  >`
    SELECT COUNT(DISTINCT "userId")::int AS active_users
    FROM public."AuditLog"
    WHERE "companyId" = ${companyId}::uuid
      AND "userId" IS NOT NULL
      AND timestamp >= ${periodRange.start}
      AND timestamp < ${periodRange.end};
  `;

  const totalMembers = toNumber(membershipStats?.total_members);
  const activeUsers = toNumber(activityStats?.active_users);
  const adoptionOverallPct = totalMembers > 0 ? (activeUsers / totalMembers) * 100 : 0;

  const moduleAdoptionRows = await prisma.$queryRaw<
    Array<{
      module: string;
      active_users: SqlScalar;
      adoption_pct: SqlScalar;
    }>
  >`
    WITH active_members AS (
      SELECT COUNT(DISTINCT "userId")::numeric AS total_members
      FROM public."UserCompanyMembership"
      WHERE "companyId" = ${companyId}::uuid
    ),
    usage_events AS (
      SELECT
        "userId",
        CASE
          WHEN "tableName" IN ('Invoice', 'Payment', 'SupplierInvoice', 'SupplierPayment') THEN 'commercial'
          WHEN "tableName" IN ('JournalEntry', 'JournalLine', 'Account') THEN 'accounting'
          WHEN "tableName" IN ('BankStatement', 'BankStatementLine', 'OpenBankingConnection') THEN 'treasury'
          WHEN "tableName" IN ('PayrollRun', 'Employee') THEN 'payroll'
          WHEN "tableName" IN ('Asset', 'AssetDepreciation') THEN 'assets'
          ELSE 'other'
        END AS module
      FROM public."AuditLog"
      WHERE "companyId" = ${companyId}::uuid
        AND "userId" IS NOT NULL
        AND timestamp >= ${periodRange.start}
        AND timestamp < ${periodRange.end}
    )
    SELECT
      u.module,
      COUNT(DISTINCT u."userId")::int AS active_users,
      ROUND(
        100.0 * COUNT(DISTINCT u."userId") / NULLIF((SELECT total_members FROM active_members), 0),
        2
      )::numeric AS adoption_pct
    FROM usage_events u
    GROUP BY u.module
    ORDER BY u.module;
  `;

  const [onboardingStats] = await prisma.$queryRaw<
    Array<{
      new_members_count: SqlScalar;
      activated_members_count: SqlScalar;
      avg_days_to_first_action: SqlScalar;
    }>
  >`
    WITH new_members AS (
      SELECT
        m."userId",
        m."createdAt"
      FROM public."UserCompanyMembership" m
      WHERE m."companyId" = ${companyId}::uuid
        AND m."createdAt" >= ${periodRange.start}
        AND m."createdAt" < ${periodRange.end}
        AND m.role IN ('ADMIN', 'CHIEF_ACCOUNTANT', 'ACCOUNTANT', 'CASHIER')
    ),
    first_actions AS (
      SELECT
        nm."userId",
        nm."createdAt" AS membership_created_at,
        MIN(a.timestamp) AS first_action_at
      FROM new_members nm
      LEFT JOIN public."AuditLog" a
        ON a."companyId" = ${companyId}::uuid
       AND a."userId" = nm."userId"
       AND a.timestamp >= nm."createdAt"
      GROUP BY nm."userId", nm."createdAt"
    )
    SELECT
      COUNT(*)::int AS new_members_count,
      COUNT(*) FILTER (WHERE first_action_at IS NOT NULL)::int AS activated_members_count,
      COALESCE(
        ROUND(AVG(EXTRACT(EPOCH FROM (first_action_at - membership_created_at)) / 86400)::numeric, 2),
        0
      )::numeric AS avg_days_to_first_action
    FROM first_actions;
  `;

  const newMembersCount = toNumber(onboardingStats?.new_members_count);
  const activatedMembersCount = toNumber(onboardingStats?.activated_members_count);
  const onboardingAvgDays = toNumber(onboardingStats?.avg_days_to_first_action);

  const [fiscalExportFailures] = await prisma.$queryRaw<
    Array<{
      failed_exports: SqlScalar;
    }>
  >`
    SELECT COUNT(*)::int AS failed_exports
    FROM public."ExportJob"
    WHERE "companyId" = ${companyId}::uuid
      AND status = 'FAILED'
      AND kind IN ('ANAF_D300', 'ANAF_D394', 'ANAF_D112', 'ANAF_D406')
      AND "createdAt" >= ${periodRange.start}
      AND "createdAt" < ${periodRange.end};
  `;

  const [efacturaRejected] = await prisma.$queryRaw<
    Array<{
      rejected_efactura: SqlScalar;
    }>
  >`
    SELECT COUNT(*)::int AS rejected_efactura
    FROM public."Invoice"
    WHERE "companyId" = ${companyId}::uuid
      AND kind = 'FISCAL'
      AND COALESCE("efacturaStatus", '') = 'REJECTED'
      AND "issueDate" >= ${periodRange.start}
      AND "issueDate" < ${periodRange.end};
  `;

  const failedExportsCount = toNumber(fiscalExportFailures?.failed_exports);
  const rejectedEfacturaCount = toNumber(efacturaRejected?.rejected_efactura);
  const fiscalErrorsCount = failedExportsCount + rejectedEfacturaCount;

  const metrics: MetricRow[] = [
    {
      metric: 'BIZ-01 Manual work reduction',
      target: '> 70%',
      actual: toPercent(automationReductionPct),
      status: evaluateHigherIsBetter(automationReductionPct, 70),
      notes: `manual_entries=${manualEntries}, total_entries=${totalEntries}`,
    },
    {
      metric: 'BIZ-02 e-Factura on-time',
      target: '> 99.5%',
      actual: `${toPercent(efacturaOnTimePct)} (${submittedOnTime}/${totalFiscal})`,
      status: evaluateHigherIsBetter(efacturaOnTimePct, 99.5),
      notes: 'deadline = issueDate + 5 days',
    },
    {
      metric: 'BIZ-03 Fiscal compliance errors',
      target: '= 0',
      actual: `${fiscalErrorsCount}`,
      status: evaluateEquals(fiscalErrorsCount, 0),
      notes: `failed_exports=${failedExportsCount}, efactura_rejected=${rejectedEfacturaCount}`,
    },
    {
      metric: 'BIZ-04 Feature adoption',
      target: '> 85%',
      actual: `${toPercent(adoptionOverallPct)} (${activeUsers}/${totalMembers})`,
      status: evaluateHigherIsBetter(adoptionOverallPct, 85),
      notes: 'active users with at least one audit event in period',
    },
    {
      metric: 'BIZ-05 Onboarding time',
      target: '< 2 days',
      actual: `${toDays(onboardingAvgDays)} (activated ${activatedMembersCount}/${newMembersCount})`,
      status: evaluateLowerIsBetter(onboardingAvgDays, 2),
      notes: 'from membership createdAt to first business action',
    },
    {
      metric: 'BIZ-06 User satisfaction (NPS 1-5)',
      target: '> 4.0/5',
      actual: npsScore === null ? 'N/A' : `${npsScore.toFixed(2)}${npsRespondents === null ? '' : ` (n=${npsRespondents})`}`,
      status: npsScore === null ? 'N/A' : evaluateHigherIsBetter(npsScore, 4),
      notes: npsScore === null ? 'set KPI_REPORT_NPS_SCORE / --nps-score' : 'input provided externally',
    },
  ];

  const reportGeneratedAt = new Date().toISOString();
  const moduleAdoptionTable = moduleAdoptionRows.length
    ? moduleAdoptionRows
        .map((row) => {
          const active = toNumber(row.active_users);
          const pct = toNumber(row.adoption_pct);
          return `| ${row.module} | ${active} | ${toPercent(pct)} |`;
        })
        .join('\n')
    : '| n/a | 0 | 0.00% |';

  const metricTable = metrics
    .map((row) => `| ${row.metric} | ${row.target} | ${row.actual} | ${row.status} | ${row.notes} |`)
    .join('\n');

  const markdown = `# KPI Business Monthly Report

Period: ${periodRange.period}  
Company: ${companyId}  
Generated at (UTC): ${reportGeneratedAt}

## Executive Summary

| Metric | Target | Actual | Status | Notes |
|---|---|---|---|---|
${metricTable}

## Adoption Breakdown by Module

| Module | Active users | Adoption |
|---|---|---|
${moduleAdoptionTable}

## Data Sources

- \`public."JournalEntry"\`
- \`public."Invoice"\`
- \`public."ExportJob"\`
- \`public."AuditLog"\`
- \`public."UserCompanyMembership"\`

## Interpretation Rules

- \`PASS\`: target achieved for the period.
- \`FAIL\`: target not achieved for the period.
- \`N/A\`: metric cannot be evaluated from current runtime inputs.
`;

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, 'utf8');

  console.log(`[kpi-monthly-report] Generated report: ${outputPath}`);
  console.log(`[kpi-monthly-report] Period=${periodRange.period} Company=${companyId}`);
}

run()
  .catch((error) => {
    console.error(`[kpi-monthly-report] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
