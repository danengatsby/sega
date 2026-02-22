import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/http-error.js';
import { ensureUserHasCompanyMembership, readRequestedCompanyId, resolveUserCompanyAccessContext } from '../lib/company-access.js';

export async function resolveCompanyContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw HttpError.unauthorized();
    }

    const requestedCompanyId = readRequestedCompanyId(req);
    await ensureUserHasCompanyMembership(req.user.id, req.user.role);

    const accessContext = await resolveUserCompanyAccessContext(req.user.id, requestedCompanyId);
    if (!accessContext) {
      if (requestedCompanyId) {
        throw HttpError.forbidden('Nu ai acces la compania selectată.');
      }
      throw HttpError.forbidden('Nu ai nicio companie activă asociată utilizatorului.');
    }

    req.user.companyId = accessContext.companyId;
    req.user.companyCode = accessContext.companyCode;
    req.user.companyName = accessContext.companyName;
    req.user.companyRole = accessContext.role;
    req.user.permissions = accessContext.permissions;
    req.user.availableCompanies = accessContext.availableCompanies;

    next();
  } catch (error) {
    next(error);
  }
}

