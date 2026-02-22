import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import type { AnafDeclarationType } from '../utils/anaf.js';
import {
  buildAnafDeclarationXml,
  buildD406ConformityReport,
  hasAnafBlockingErrors,
  validateAnafBusinessProfile,
  validateAnafPayload,
} from '../services/reports/anaf-service.js';
import { buildDashboardBiReport } from '../services/reports/dashboard-bi-service.js';
import { buildExcelContent, buildPdfContent, buildXmlContent } from '../services/reports/financial-export-service.js';
import { buildXbrlContent, validateXbrlWithSchema } from '../services/reports/xbrl-export-service.js';
import {
  annualRange,
  parseAnafPeriod,
  parseBooleanQuery,
  parseDateInput,
  parseDecimalQuery,
  parseFinancialYear,
  parseIntegerQuery,
  parseRange,
  resolveAnafValidateRequested,
  setAnafValidationHeaders,
} from '../services/reports/helpers.js';
import { getStatements } from '../services/reports/statements-service.js';

const EXTENDED_ANAF_DECLARATIONS: AnafDeclarationType[] = [
  'd300',
  'd394',
  'd112',
  'd101',
  'd100',
  'd205',
  'd392',
  'd393',
  'd406',
];

export async function getTrialBalance(req: Request, res: Response): Promise<void> {
  const bundle = await getStatements(req.user!.companyId!, parseRange(req));
  res.json(bundle.trialBalance);
}

export async function getPnl(req: Request, res: Response): Promise<void> {
  const bundle = await getStatements(req.user!.companyId!, parseRange(req));
  res.json(bundle.pnl);
}

export async function getBalanceSheet(req: Request, res: Response): Promise<void> {
  const bundle = await getStatements(req.user!.companyId!, parseRange(req));
  res.json(bundle.balanceSheet);
}

export async function getAgingReceivables(req: Request, res: Response): Promise<void> {
  const bundle = await getStatements(req.user!.companyId!, parseRange(req));
  res.json(bundle.aging);
}

export async function getFinancialStatements(req: Request, res: Response): Promise<void> {
  const bundle = await getStatements(req.user!.companyId!, parseRange(req));
  res.json(bundle);
}

export async function getDashboardBi(req: Request, res: Response): Promise<void> {
  const asOf = parseDateInput(req.query.asOf, 'asOf') ?? new Date();
  const dueSoonDays = parseIntegerQuery(req.query.dueSoonDays, 'dueSoonDays', 7, 1, 90);
  const overdueGraceDays = parseIntegerQuery(req.query.overdueGraceDays, 'overdueGraceDays', 0, 0, 90);
  const minAmount = parseDecimalQuery(req.query.minAmount, 'minAmount', 0, 0, 1_000_000_000);
  const maxAlerts = parseIntegerQuery(req.query.maxAlerts, 'maxAlerts', 20, 1, 100);

  const report = await buildDashboardBiReport(req.user!.companyId!, {
    asOf,
    dueSoonDays,
    overdueGraceDays,
    minAmount,
    maxAlerts,
  });
  res.json(report);
}

export async function exportFinancialPdf(req: Request, res: Response): Promise<void> {
  const bundle = await getStatements(req.user!.companyId!, parseRange(req));
  const pdf = buildPdfContent(bundle);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="situatii-financiare.pdf"');
  res.send(pdf);
}

export async function exportFinancialExcel(req: Request, res: Response): Promise<void> {
  const bundle = await getStatements(req.user!.companyId!, parseRange(req));
  const csv = `\uFEFF${buildExcelContent(bundle)}`;

  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="situatii-financiare.csv"');
  res.send(csv);
}

export async function exportFinancialXml(req: Request, res: Response): Promise<void> {
  const bundle = await getStatements(req.user!.companyId!, parseRange(req));
  const xml = buildXmlContent(bundle);

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="situatii-financiare.xml"');
  res.send(xml);
}

export async function exportFinancialXbrl(req: Request, res: Response): Promise<void> {
  const year = parseFinancialYear(req.query.year);
  const strict = env.NODE_ENV === 'production' ? true : parseBooleanQuery(req.query.strict, false);
  const validateRequested = strict || parseBooleanQuery(req.query.validate, true);
  const bundle = await getStatements(req.user!.companyId!, annualRange(year));
  const xbrl = buildXbrlContent(bundle, {
    year,
    entityIdentifier: req.user!.companyId!,
  });
  const validation = await validateXbrlWithSchema(xbrl, validateRequested);

  res.setHeader('X-XBRL-Year', String(year));
  res.setHeader('X-XBRL-XSD-Performed', validation.performed ? 'true' : 'false');
  res.setHeader('X-XBRL-XSD-Valid', validation.valid === null ? 'unknown' : validation.valid ? 'true' : 'false');
  if (validation.schemaPath) {
    res.setHeader('X-XBRL-XSD-Schema', validation.schemaPath);
  }

  if (strict && validation.valid !== true) {
    res.status(422).json({
      message: 'Exportul XBRL nu a trecut validarea strictă pe schema țintă.',
      strict,
      year,
      validation,
    });
    return;
  }

  res.setHeader('Content-Type', 'application/xbrl+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="situatii-financiare-${year}.xbrl"`);
  res.send(xbrl);
}

async function buildPayload(type: AnafDeclarationType, req: Request) {
  const period = parseAnafPeriod(req.query.period);
  const companyId = req.user!.companyId!;
  return { period, payload: await buildAnafDeclarationXml(type, companyId, period) };
}

export function createAnafExportHandler(type: AnafDeclarationType) {
  return async (req: Request, res: Response): Promise<void> => {
    const strict = env.NODE_ENV === 'production' ? true : parseBooleanQuery(req.query.strict, false);
    const validateRequested = resolveAnafValidateRequested(strict, parseBooleanQuery(req.query.validate, false));
    const businessProfile = validateAnafBusinessProfile();

    if (strict && !businessProfile.valid) {
      res.status(422).json({
        message: 'Profilul ANAF al companiei este incomplet sau folosește fallback-uri demo. Export blocat în strict mode.',
        strict,
        businessProfile,
      });
      return;
    }

    const { period, payload } = await buildPayload(type, req);
    const validation = await validateAnafPayload(payload, validateRequested);

    setAnafValidationHeaders(res, validation);

    if (strict && hasAnafBlockingErrors(validation, { requireXsdPerformed: true })) {
      res.status(422).json({
        message: `Declarația ${validation.declaration} nu a trecut validarea strictă.`,
        strict,
        businessProfile,
        validation,
      });
      return;
    }

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${validation.declaration}-${period.period}.xml"`);
    res.send(payload.xml);
  };
}

export async function exportD406Conformity(req: Request, res: Response): Promise<void> {
  const period = parseAnafPeriod(req.query.period);
  const companyId = req.user!.companyId!;
  const report = await buildD406ConformityReport(companyId, period);
  res.json(report);
}

export async function exportAnafValidation(req: Request, res: Response): Promise<void> {
  const period = parseAnafPeriod(req.query.period);
  const companyId = req.user!.companyId!;
  const strict = env.NODE_ENV === 'production' ? true : parseBooleanQuery(req.query.strict, false);
  const validateRequested = resolveAnafValidateRequested(strict, parseBooleanQuery(req.query.validate, true));
  const businessProfile = validateAnafBusinessProfile();
  const results = await Promise.all(
    EXTENDED_ANAF_DECLARATIONS.map(async (type) =>
      validateAnafPayload(await buildAnafDeclarationXml(type, companyId, period), validateRequested),
    ),
  );

  res.json({
    generatedAt: new Date().toISOString(),
    period: period.period,
    strict,
    businessProfile,
    results,
  });
}
