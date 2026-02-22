import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { env } from '../config/env.js';
import { logger, requestLogger } from '../lib/logger.js';
import { metricsHandler, metricsMiddleware } from '../lib/metrics.js';
import { startNotificationWorker } from '../lib/notification-queue.js';
import { authenticate, enforceMfaEnrollment, enforcePasswordChange } from '../middleware/auth.js';
import { resolveCompanyContext } from '../middleware/company.js';
import { bindDbRequestContext } from '../middleware/db-context.js';
import { errorHandler, notFound } from '../middleware/error.js';
import { buildServiceOpenApiDocument } from '../openapi/service-contracts.js';
import invoiceRoutes from '../routes/invoices.js';

function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function createInvoiceServiceApp(): Express {
  const app = express();
  const openApiDocument = buildServiceOpenApiDocument('invoice-service');

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
      service: 'invoice-service',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });

  app.use('/api/docs', (_req, res, next) => {
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
      customSiteTitle: 'SEGA Invoice Service API Docs',
      swaggerOptions: {
        persistAuthorization: true,
      },
    }),
  );

  app.use('/api', authenticate);
  app.use('/api', resolveCompanyContext);
  app.use('/api', enforcePasswordChange);
  app.use('/api', enforceMfaEnrollment);
  app.use('/api', bindDbRequestContext);
  app.use('/api/invoices', invoiceRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export function startInvoiceService(port = env.INVOICE_SERVICE_PORT): void {
  const app = createInvoiceServiceApp();
  startNotificationWorker();
  app.listen(port, () => {
    logger.info('invoice_service_started', {
      port,
      url: `http://localhost:${port}`,
    });
  });
}
