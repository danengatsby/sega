import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import journalRoutes from './routes/journal.js';
import partnerRoutes from './routes/partners.js';
import invoiceRoutes from './routes/invoices.js';
import reportRoutes from './routes/reports.js';
import auditRoutes from './routes/audit.js';
import employeeRoutes from './routes/employees.js';
import payrollRoutes from './routes/payroll.js';
import assetRoutes from './routes/assets.js';
import periodRoutes from './routes/periods.js';
import purchaseRoutes from './routes/purchases.js';
import stockRoutes from './routes/stocks.js';
import bankReconciliationRoutes from './routes/bank-reconciliation.js';
import openBankingRoutes from './routes/open-banking.js';
import exportJobRoutes from './routes/export-jobs.js';
import dashboardSnapshotRoutes from './routes/dashboard-snapshots.js';
import revisalRoutes from './routes/revisal.js';
import adminRoutes from './routes/admin.js';
import complianceRoutes from './routes/compliance.js';
import eTransportRoutes from './routes/e-transport.js';
import { authenticate, enforceCompanySelection, enforceMfaEnrollment, enforcePasswordChange } from './middleware/auth.js';
import { resolveCompanyContext } from './middleware/company.js';
import { bindDbRequestContext } from './middleware/db-context.js';
import { errorHandler, notFound } from './middleware/error.js';
import { startExportJobWorker } from './lib/export-job-queue.js';
import { logger, requestLogger } from './lib/logger.js';
import { metricsHandler, metricsMiddleware } from './lib/metrics.js';
import { startNotificationWorker } from './lib/notification-queue.js';
import { getOpenApiDocument } from './openapi/spec.js';
import { startOpenBankingScheduler } from './services/open-banking/scheduler.js';

function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function createApp(): Express {
  const app = express();
  const openApiDocument = getOpenApiDocument();
  const authPublicRateLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX_PUBLIC,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      message: 'Prea multe cereri către endpoint-urile publice. Încearcă din nou în câteva momente.',
      code: 'RATE_LIMIT_EXCEEDED',
    },
  });

  const authLoginRateLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX_LOGIN,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      message: 'Prea multe încercări de autentificare. Încearcă din nou în câteva momente.',
      code: 'LOGIN_RATE_LIMIT_EXCEEDED',
    },
  });

  const configuredCorsOrigins = env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }

        if (configuredCorsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        if (env.NODE_ENV !== 'production' && isLocalDevOrigin(origin)) {
          callback(null, true);
          return;
        }

        callback(null, false);
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          connectSrc: ["'self'", ...configuredCorsOrigins],
          imgSrc: ["'self'", 'data:'],
          styleSrc: ["'self'"],
          ...(env.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {}),
        },
      },
    }),
  );
  app.use(requestLogger);
  app.use(express.json({ limit: '2mb' }));
  app.use(metricsMiddleware);

  app.get('/metrics', metricsHandler);

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });

  app.use('/api/docs', (_req, res, next) => {
    // Swagger UI folosește script/style inline; relaxăm CSP strict doar pe ruta de documentație.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'SEGA API Docs',
      swaggerOptions: {
        persistAuthorization: true,
      },
    }),
  );

  app.use('/api/auth/login', authLoginRateLimiter);
  app.use('/api/auth', authPublicRateLimiter);
  app.use('/api/auth', authRoutes);

  app.use('/api', authenticate);
  app.use('/api', enforceCompanySelection);
  app.use('/api', resolveCompanyContext);
  app.use('/api', enforcePasswordChange);
  app.use('/api', enforceMfaEnrollment);
  app.use('/api', bindDbRequestContext);
  app.use('/api/admin', adminRoutes);
  app.use('/api/compliance', complianceRoutes);
  app.use('/api/e-transport', eTransportRoutes);
  app.use('/api/accounts', accountRoutes);
  app.use('/api/journal-entries', journalRoutes);
  app.use('/api/partners', partnerRoutes);
  app.use('/api/invoices', invoiceRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/audit-log', auditRoutes);
  app.use('/api/employees', employeeRoutes);
  app.use('/api/payroll', payrollRoutes);
  app.use('/api/assets', assetRoutes);
  app.use('/api/periods', periodRoutes);
  app.use('/api/purchases', purchaseRoutes);
  app.use('/api/stocks', stockRoutes);
  app.use('/api/bank-reconciliation', bankReconciliationRoutes);
  app.use('/api/open-banking', openBankingRoutes);
  app.use('/api/export-jobs', exportJobRoutes);
  app.use('/api/dashboard-snapshots', dashboardSnapshotRoutes);
  app.use('/api/revisal', revisalRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export function startServer(port = env.PORT): void {
  const app = createApp();
  startExportJobWorker();
  startNotificationWorker();
  startOpenBankingScheduler();
  app.listen(port, () => {
    logger.info('backend_started', {
      port,
      url: `http://localhost:${port}`,
    });
  });
}
