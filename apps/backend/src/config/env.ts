import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  AUTH_SERVICE_PORT: z.coerce.number().default(4101),
  INVOICE_SERVICE_PORT: z.coerce.number().default(4102),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Legacy HS256 secrets kept for backward compatibility with older setups.
  JWT_SECRET: z.string().min(10, 'JWT_SECRET should be at least 10 chars').optional(),
  JWT_REFRESH_SECRET: z.string().min(10, 'JWT_REFRESH_SECRET should be at least 10 chars').optional(),
  JWT_ACCESS_PRIVATE_KEY: z.string().min(32).optional(),
  JWT_ACCESS_PUBLIC_KEY: z.string().min(32).optional(),
  JWT_REFRESH_PRIVATE_KEY: z.string().min(32).optional(),
  JWT_REFRESH_PUBLIC_KEY: z.string().min(32).optional(),
  JWT_ACCESS_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_PUBLIC: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_MAX_LOGIN: z.coerce.number().int().positive().default(10),
  REPORTS_CACHE_TTL_MS: z.coerce.number().int().positive().default(15000),
  REDIS_URL: z.string().min(1).optional(),
  LOG_SERVICE_NAME: z.string().min(2).default('sega-backend'),
  LOGSTASH_ENABLED: z.coerce.boolean().default(false),
  LOGSTASH_HOST: z.string().min(1).default('localhost'),
  LOGSTASH_PORT: z.coerce.number().int().positive().default(5044),
  LOGSTASH_RECONNECT_MS: z.coerce.number().int().positive().default(3000),
  LOGSTASH_MAX_QUEUE: z.coerce.number().int().positive().default(1000),
  LOG_REQUEST_FILTER: z.enum(['auto', 'all', 'non-2xx', 'errors-only']).default('auto'),
  LOG_REQUEST_EXCLUDE_PATHS: z.string().default('/metrics,/api/health'),
  EXPORT_JOB_QUEUE_MODE: z.enum(['auto', 'poll', 'bull']).default('auto'),
  EXPORT_JOB_BULL_CONCURRENCY: z.coerce.number().int().positive().default(2),
  EXPORT_JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  NOTIFICATIONS_ENABLED: z.coerce.boolean().default(true),
  NOTIFICATION_QUEUE_MODE: z.enum(['auto', 'memory', 'bull']).default('auto'),
  NOTIFICATION_BULL_CONCURRENCY: z.coerce.number().int().positive().default(4),
  NOTIFICATION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  NOTIFICATION_CHANNELS: z.string().default('email,sms,push'),
  NOTIFICATION_TARGET_ROLES: z.string().default('ADMIN,CHIEF_ACCOUNTANT,MANAGER'),
  NOTIFICATION_INCLUDE_ACTOR: z.coerce.boolean().default(false),
  NOTIFICATION_EMAIL_RECIPIENTS: z.string().default(''),
  NOTIFICATION_SMS_RECIPIENTS: z.string().default(''),
  NOTIFICATION_PUSH_RECIPIENTS: z.string().default(''),
  NOTIFICATION_EMAIL_WEBHOOK_URL: z.string().url().optional(),
  NOTIFICATION_SMS_WEBHOOK_URL: z.string().url().optional(),
  NOTIFICATION_PUSH_WEBHOOK_URL: z.string().url().optional(),
  NOTIFICATION_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(7000),
  MINIO_ENDPOINT: z.string().url().default('http://localhost:9000'),
  MINIO_REGION: z.string().default('us-east-1'),
  MINIO_ACCESS_KEY: z.string().min(1).optional(),
  MINIO_SECRET_KEY: z.string().min(1).optional(),
  MINIO_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  MINIO_BUCKET_EFACTURA: z.string().min(3).default('efactura'),
  MINIO_AUTO_CREATE_BUCKETS: z.coerce.boolean().default(true),
  OPEN_BANKING_ENABLED: z.coerce.boolean().default(false),
  OPEN_BANKING_PILOT_BANK: z.enum(['bcr']).default('bcr'),
  OPEN_BANKING_DAILY_SYNC_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(3),
  OPEN_BANKING_BCR_TOKEN_URL: z.string().url().optional(),
  OPEN_BANKING_BCR_ACCOUNTS_URL: z.string().url().optional(),
  OPEN_BANKING_BCR_TRANSACTIONS_URL: z.string().url().optional(),
  OPEN_BANKING_BCR_CLIENT_ID: z.string().min(3).optional(),
  OPEN_BANKING_BCR_CLIENT_SECRET: z.string().min(8).optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  BOOTSTRAP_ADMIN_ENABLED: z.coerce.boolean().default(false),
  BOOTSTRAP_ADMIN_TOKEN: z.string().min(24).optional(),
  ANAF_COMPANY_NAME: z.string().min(2).default('SEGA DEMO SRL'),
  ANAF_COMPANY_CUI: z.string().min(2).default('RO00000000'),
  ANAF_COMPANY_ADDRESS: z.string().min(5).default('Bucuresti, Romania'),
  ANAF_COMPANY_CAEN: z.string().min(2).default('6201'),
  ANAF_DECLARANT_NAME: z.string().min(2).default('Administrator'),
  ANAF_DECLARANT_FUNCTION: z.string().min(2).default('Administrator'),
  ANAF_VALIDATE_XSD: z.coerce.boolean().default(false),
  ANAF_XSD_DIR: z.string().default('./anaf/xsd'),
  ANAF_PROFILE_VERSION: z.string().default('SPV-MVP-1.0'),
  ANAF_EFACTURA_MODE: z.enum(['off', 'mock', 'live']).default('off'),
  ANAF_EFACTURA_BASE_URL: z.string().url().default('https://webservicesp.anaf.ro/prod/FCTEL/rest'),
  ANAF_EFACTURA_OAUTH_TOKEN: z.string().min(16).optional(),
  ANAF_EFACTURA_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  ANAF_EFACTURA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  ANAF_EFACTURA_MAX_POLLS: z.coerce.number().int().positive().default(12),
  ANAF_EFACTURA_STORAGE_DIR: z.string().default('./storage/efactura'),
}).superRefine((data, ctx) => {
  if ((data.ADMIN_EMAIL && !data.ADMIN_PASSWORD) || (!data.ADMIN_EMAIL && data.ADMIN_PASSWORD)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ADMIN_EMAIL'],
      message: 'ADMIN_EMAIL și ADMIN_PASSWORD trebuie setate împreună.',
    });
  }

  if (data.BOOTSTRAP_ADMIN_ENABLED && !data.BOOTSTRAP_ADMIN_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BOOTSTRAP_ADMIN_TOKEN'],
      message: 'BOOTSTRAP_ADMIN_TOKEN este obligatoriu când BOOTSTRAP_ADMIN_ENABLED=true.',
    });
  }

  if ((data.MINIO_ACCESS_KEY && !data.MINIO_SECRET_KEY) || (!data.MINIO_ACCESS_KEY && data.MINIO_SECRET_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MINIO_ACCESS_KEY'],
      message: 'MINIO_ACCESS_KEY și MINIO_SECRET_KEY trebuie setate împreună.',
    });
  }

  if (data.JWT_SECRET && data.JWT_REFRESH_SECRET && data.JWT_SECRET === data.JWT_REFRESH_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_REFRESH_SECRET'],
      message: 'JWT_REFRESH_SECRET trebuie să fie diferit de JWT_SECRET.',
    });
  }

  const hasAccessPrivate = Boolean(data.JWT_ACCESS_PRIVATE_KEY);
  const hasAccessPublic = Boolean(data.JWT_ACCESS_PUBLIC_KEY);
  if (hasAccessPrivate !== hasAccessPublic) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_ACCESS_PRIVATE_KEY'],
      message: 'JWT_ACCESS_PRIVATE_KEY și JWT_ACCESS_PUBLIC_KEY trebuie setate împreună.',
    });
  }

  const hasRefreshPrivate = Boolean(data.JWT_REFRESH_PRIVATE_KEY);
  const hasRefreshPublic = Boolean(data.JWT_REFRESH_PUBLIC_KEY);
  if (hasRefreshPrivate !== hasRefreshPublic) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_REFRESH_PRIVATE_KEY'],
      message: 'JWT_REFRESH_PRIVATE_KEY și JWT_REFRESH_PUBLIC_KEY trebuie setate împreună.',
    });
  }

  if (data.NODE_ENV === 'production') {
    if (!hasAccessPrivate || !hasAccessPublic) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_PRIVATE_KEY'],
        message: 'În producție este obligatorie configurarea cheilor RSA pentru access token.',
      });
    }

    if (!hasRefreshPrivate || !hasRefreshPublic) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_PRIVATE_KEY'],
        message: 'În producție este obligatorie configurarea cheilor RSA pentru refresh token.',
      });
    }
  }

  if (data.ANAF_EFACTURA_MODE === 'live' && !data.ANAF_EFACTURA_OAUTH_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ANAF_EFACTURA_OAUTH_TOKEN'],
      message: 'ANAF_EFACTURA_OAUTH_TOKEN este obligatoriu când ANAF_EFACTURA_MODE=live.',
    });
  }

  if (data.ANAF_EFACTURA_MODE !== 'off' && (!data.MINIO_ACCESS_KEY || !data.MINIO_SECRET_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MINIO_ACCESS_KEY'],
      message: 'MINIO_ACCESS_KEY și MINIO_SECRET_KEY sunt obligatorii când ANAF_EFACTURA_MODE!=off.',
    });
  }

  if (data.OPEN_BANKING_ENABLED) {
    if (!data.OPEN_BANKING_BCR_TOKEN_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPEN_BANKING_BCR_TOKEN_URL'],
        message: 'OPEN_BANKING_BCR_TOKEN_URL este obligatoriu când OPEN_BANKING_ENABLED=true.',
      });
    }
    if (!data.OPEN_BANKING_BCR_ACCOUNTS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPEN_BANKING_BCR_ACCOUNTS_URL'],
        message: 'OPEN_BANKING_BCR_ACCOUNTS_URL este obligatoriu când OPEN_BANKING_ENABLED=true.',
      });
    }
    if (!data.OPEN_BANKING_BCR_TRANSACTIONS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPEN_BANKING_BCR_TRANSACTIONS_URL'],
        message: 'OPEN_BANKING_BCR_TRANSACTIONS_URL este obligatoriu când OPEN_BANKING_ENABLED=true.',
      });
    }
    if (!data.OPEN_BANKING_BCR_CLIENT_ID || !data.OPEN_BANKING_BCR_CLIENT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPEN_BANKING_BCR_CLIENT_ID'],
        message: 'OPEN_BANKING_BCR_CLIENT_ID și OPEN_BANKING_BCR_CLIENT_SECRET sunt obligatorii când OPEN_BANKING_ENABLED=true.',
      });
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

function hasExplicitEnvValue(key: string): boolean {
  const value = process.env[key];
  return typeof value === 'string' && value.trim().length > 0;
}

export const envMeta = {
  anafProfile: {
    companyNameProvided: hasExplicitEnvValue('ANAF_COMPANY_NAME'),
    companyCuiProvided: hasExplicitEnvValue('ANAF_COMPANY_CUI'),
    companyAddressProvided: hasExplicitEnvValue('ANAF_COMPANY_ADDRESS'),
    companyCaenProvided: hasExplicitEnvValue('ANAF_COMPANY_CAEN'),
    declarantNameProvided: hasExplicitEnvValue('ANAF_DECLARANT_NAME'),
    declarantFunctionProvided: hasExplicitEnvValue('ANAF_DECLARANT_FUNCTION'),
  },
} as const;
