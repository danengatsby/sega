import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const register = new Registry();
collectDefaultMetrics({
  register,
  prefix: 'sega_backend_',
});

const httpRequestsTotal = new Counter({
  name: 'sega_backend_http_requests_total',
  help: 'Total number of HTTP requests served by the backend.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

const httpRequestDurationSeconds = new Histogram({
  name: 'sega_backend_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

function normalizeRoute(req: Request): string {
  if (req.route?.path) {
    return typeof req.route.path === 'string' ? req.route.path : req.path;
  }
  return req.path;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = normalizeRoute(req);
    const statusCode = String(res.statusCode);
    const labels = {
      method: req.method,
      route,
      status_code: statusCode,
    };
    httpRequestsTotal.inc(labels, 1);
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    httpRequestDurationSeconds.observe(labels, durationSeconds);
  });
  next();
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
}
