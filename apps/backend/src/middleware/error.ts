import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { HttpError } from '../lib/http-error.js';
import { logger } from '../lib/logger.js';

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ message: 'Resursa nu a fost găsită.' });
}

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError): HttpError {
  if (error.code === 'P2002') {
    return HttpError.conflict('Resursa există deja cu aceeași valoare unică.');
  }

  if (error.code === 'P2001' || error.code === 'P2025') {
    return HttpError.notFound('Resursa solicitată nu există.');
  }

  if (error.code === 'P2000') {
    return HttpError.badRequest('Valoarea unui câmp depășește lungimea permisă.');
  }

  if (error.code === 'P2003' || error.code === 'P2014') {
    return HttpError.conflict('Operațiunea încalcă constrângeri de integritate a datelor.');
  }

  return HttpError.internal();
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return HttpError.badRequest('Fișierul depășește dimensiunea maximă permisă (8MB).');
    }
    return HttpError.badRequest(`Upload fișier invalid: ${error.message}`);
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return mapPrismaError(error);
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return HttpError.badRequest('Date invalide pentru operațiune.');
  }

  return HttpError.internal();
}

function logTechnicalError(req: Request, error: unknown, httpError: HttpError): void {
  if (httpError.statusCode < 500 && error instanceof HttpError) {
    return;
  }

  const errorDetails =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : { value: error };

  logger.error('backend_error', {
    method: req.method,
    path: req.originalUrl,
    statusCode: httpError.statusCode,
    error: errorDetails,
    userId: req.user?.id ?? null,
    companyId: req.user?.companyId ?? null,
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const httpError = toHttpError(err);

  logTechnicalError(req, err, httpError);

  res.status(httpError.statusCode).json({
    message: httpError.expose ? httpError.message : 'Eroare internă de server.',
  });
}
