import { ExportJobKind, type ExportJob, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../config/env.js';
import { HttpError } from '../lib/http-error.js';
import {
  buildAnafDeclarationXml,
  hasAnafBlockingErrors,
  validateAnafBusinessProfile,
  validateAnafPayload,
} from './reports/anaf-service.js';
import { buildExcelContent, buildPdfContent, buildXmlContent } from './reports/financial-export-service.js';
import { getStatements } from './reports/statements-service.js';
import { parseAnafPeriod, parseDateInput, resolveAnafValidateRequested } from './reports/helpers.js';

const financialPayloadSchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .partial();

const anafPayloadSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  validate: z.boolean().optional(),
  strict: z.boolean().optional(),
});

const exportJobKinds = Object.values(ExportJobKind) as [ExportJobKind, ...ExportJobKind[]];

export const createExportJobSchema = z
  .object({
    kind: z.enum(exportJobKinds),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    validate: z.boolean().optional(),
    strict: z.boolean().optional(),
    maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
  })
  .superRefine((value, ctx) => {
    const isAnafKind = value.kind.startsWith('ANAF_');
    if (isAnafKind && !value.period) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Parametrul period este obligatoriu pentru exporturile ANAF.',
        path: ['period'],
      });
    }
  });

export interface ExportJobResult {
  data: Buffer;
  mimeType: string;
  filename: string;
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function toCreatePayload(input: z.infer<typeof createExportJobSchema>): Prisma.JsonObject {
  const payload: Record<string, unknown> = {};

  if (input.kind.startsWith('FINANCIAL_')) {
    if (input.from) {
      payload.from = input.from;
    }
    if (input.to) {
      payload.to = input.to;
    }
  } else {
    payload.period = input.period;
    const strict = input.strict ?? (env.NODE_ENV === 'production');
    payload.strict = strict;
    payload.validate = strict ? true : (input.validate ?? false);
  }

  return payload as Prisma.JsonObject;
}

function timestampToken(date = new Date()): string {
  const iso = date.toISOString().replace(/[:\-]/g, '').replace(/\..+$/, '');
  return iso.replace('T', '_');
}

function parseFinancialRange(payload: Prisma.JsonValue | null): { from?: Date; to?: Date } {
  const parsed = financialPayloadSchema.safeParse(jsonObject(payload));
  if (!parsed.success) {
    return {};
  }

  return {
    from: parseDateInput(parsed.data.from, 'from'),
    to: parseDateInput(parsed.data.to, 'to'),
  };
}

async function runFinancialJob(kind: ExportJobKind, companyId: string, payload: Prisma.JsonValue | null): Promise<ExportJobResult> {
  const range = parseFinancialRange(payload);
  const bundle = await getStatements(companyId, range);
  const token = timestampToken();

  if (kind === ExportJobKind.FINANCIAL_PDF) {
    return {
      data: buildPdfContent(bundle),
      mimeType: 'application/pdf',
      filename: `situatii-financiare-${token}.pdf`,
    };
  }

  if (kind === ExportJobKind.FINANCIAL_EXCEL) {
    const csv = `\uFEFF${buildExcelContent(bundle)}`;
    return {
      data: Buffer.from(csv, 'utf8'),
      mimeType: 'application/vnd.ms-excel; charset=utf-8',
      filename: `situatii-financiare-${token}.csv`,
    };
  }

  return {
    data: Buffer.from(buildXmlContent(bundle), 'utf8'),
    mimeType: 'application/xml; charset=utf-8',
    filename: `situatii-financiare-${token}.xml`,
  };
}

function declarationTypeForKind(kind: ExportJobKind): 'd300' | 'd394' | 'd112' {
  if (kind === ExportJobKind.ANAF_D300) {
    return 'd300';
  }
  if (kind === ExportJobKind.ANAF_D394) {
    return 'd394';
  }
  return 'd112';
}

async function runAnafJob(kind: ExportJobKind, companyId: string, payload: Prisma.JsonValue | null): Promise<ExportJobResult> {
  const parsedPayload = anafPayloadSchema.parse(jsonObject(payload));
  const strict = parsedPayload.strict ?? (env.NODE_ENV === 'production');
  const validateRequested = resolveAnafValidateRequested(strict, parsedPayload.validate ?? false);
  const businessProfile = validateAnafBusinessProfile();

  if (strict && !businessProfile.valid) {
    throw HttpError.badRequest(
      'Profilul ANAF al companiei este incomplet sau folosește fallback-uri demo. Export blocat în strict mode.',
    );
  }

  const period = parseAnafPeriod(parsedPayload.period);
  const declarationType = declarationTypeForKind(kind);
  const declarationPayload = await buildAnafDeclarationXml(declarationType, companyId, period);
  const validation = await validateAnafPayload(declarationPayload, validateRequested);

  if (strict && hasAnafBlockingErrors(validation, { requireXsdPerformed: true })) {
    throw HttpError.badRequest(`Declarația ${validation.declaration} nu a trecut validarea strictă.`);
  }

  return {
    data: Buffer.from(declarationPayload.xml, 'utf8'),
    mimeType: 'application/xml; charset=utf-8',
    filename: `${validation.declaration}-${period.period}.xml`,
  };
}

export async function executeExportJob(job: Pick<ExportJob, 'kind' | 'companyId' | 'payload'>): Promise<ExportJobResult> {
  if (job.kind.startsWith('FINANCIAL_')) {
    return runFinancialJob(job.kind, job.companyId, job.payload);
  }

  return runAnafJob(job.kind, job.companyId, job.payload);
}
