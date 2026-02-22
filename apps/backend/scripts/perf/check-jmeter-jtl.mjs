#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const inputFile = process.argv[2] ?? 'perf/results/jmeter/kpi-routes.jtl';

const targetP95Ms = Number(process.env.PERF_TARGET_P95_MS ?? 300);
const targetP99Ms = Number(process.env.PERF_TARGET_P99_MS ?? 700);
const dashboardP95Ms = Number(process.env.PERF_DASHBOARD_P95_MS ?? 1000);
const dashboardP99Ms = Number(process.env.PERF_DASHBOARD_P99_MS ?? 2000);

const budgets = {
  'GET /api/invoices': {
    p95: targetP95Ms,
    p99: targetP99Ms,
  },
  'GET /api/accounts': {
    p95: targetP95Ms,
    p99: targetP99Ms,
  },
  'GET /api/reports/dashboard-bi': {
    p95: dashboardP95Ms,
    p99: dashboardP99Ms,
  },
};

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function percentile(values, p) {
  if (values.length === 0) {
    return NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  return lowerValue + (upperValue - lowerValue) * weight;
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fișierul JTL nu există: ${filePath}`);
  }
}

function readJtl(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    throw new Error(`Fișierul JTL este gol: ${filePath}`);
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error(`Fișierul JTL nu are suficiente linii: ${filePath}`);
  }
  return lines;
}

function valueAt(values, index) {
  if (index < 0 || index >= values.length) {
    return '';
  }
  return values[index] ?? '';
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

function run() {
  const absolutePath = path.resolve(process.cwd(), inputFile);
  ensureFileExists(absolutePath);
  const lines = readJtl(absolutePath);
  const headers = parseCsvLine(lines[0]);

  const labelIndex = headers.indexOf('label');
  const elapsedIndex = headers.indexOf('elapsed');
  const responseCodeIndex = headers.indexOf('responseCode');
  const successIndex = headers.indexOf('success');

  if (labelIndex < 0 || elapsedIndex < 0 || responseCodeIndex < 0 || successIndex < 0) {
    throw new Error(
      'JTL trebuie să conțină coloanele label, elapsed, responseCode, success. Ajustează jmeter.save.saveservice.',
    );
  }

  const stats = new Map();
  for (const label of Object.keys(budgets)) {
    stats.set(label, {
      durations: [],
      errors: 0,
      total: 0,
    });
  }

  for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
    const row = parseCsvLine(lines[rowIndex]);
    const label = valueAt(row, labelIndex);
    const stat = stats.get(label);
    if (!stat) {
      continue;
    }

    const elapsed = Number(valueAt(row, elapsedIndex));
    const responseCode = valueAt(row, responseCodeIndex);
    const success = valueAt(row, successIndex).toLowerCase() === 'true';
    stat.total += 1;

    if (!Number.isFinite(elapsed)) {
      stat.errors += 1;
      continue;
    }

    stat.durations.push(elapsed);
    if (!success || responseCode !== '200') {
      stat.errors += 1;
    }
  }

  let hasFailures = false;
  for (const [label, budget] of Object.entries(budgets)) {
    const stat = stats.get(label);
    if (!stat || stat.total === 0 || stat.durations.length === 0) {
      console.error(`[FAIL] ${label}: fără mostre în JTL.`);
      hasFailures = true;
      continue;
    }

    const p95 = percentile(stat.durations, 95);
    const p99 = percentile(stat.durations, 99);
    const errorRate = stat.total === 0 ? 1 : stat.errors / stat.total;

    const p95Pass = p95 < budget.p95;
    const p99Pass = p99 < budget.p99;
    const errorsPass = errorRate < 0.01;

    const status = p95Pass && p99Pass && errorsPass ? 'OK' : 'FAIL';
    console.log(
      `[${status}] ${label} samples=${stat.total} p95=${formatMs(p95)} (target < ${budget.p95}ms) p99=${formatMs(p99)} (target < ${budget.p99}ms) errors=${(errorRate * 100).toFixed(2)}%`,
    );

    if (!p95Pass || !p99Pass || !errorsPass) {
      hasFailures = true;
    }
  }

  if (hasFailures) {
    process.exit(1);
  }
}

run();
