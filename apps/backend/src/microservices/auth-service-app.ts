import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { env } from '../config/env.js';
import { logger, requestLogger } from '../lib/logger.js';
import { metricsHandler, metricsMiddleware } from '../lib/metrics.js';
import { errorHandler, notFound } from '../middleware/error.js';
import { buildServiceOpenApiDocument } from '../openapi/service-contracts.js';
import authRoutes from '../routes/auth.js';

function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function createAuthServiceApp(): Express {
  const app = express();
  const openApiDocument = buildServiceOpenApiDocument('auth-service');

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
      service: 'auth-service',
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
      customSiteTitle: 'SEGA Auth Service API Docs',
      swaggerOptions: {
        persistAuthorization: true,
      },
    }),
  );

  app.use('/api/auth/login', authLoginRateLimiter);
  app.use('/api/auth', authPublicRateLimiter);
  app.use('/api/auth', authRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export function startAuthService(port = env.AUTH_SERVICE_PORT): void {
  const app = createAuthServiceApp();
  app.listen(port, () => {
    logger.info('auth_service_started', {
      port,
      url: `http://localhost:${port}`,
    });
  });
}
