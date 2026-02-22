import type { Role } from '@prisma/client';
import type { AvailableCompany } from '../lib/company-access.js';
import type { Permission } from '../lib/rbac.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: Role;
        sessionId?: string;
        name: string;
        mustChangePassword: boolean;
        mfaEnabled: boolean;
        companyId?: string;
        companyCode?: string;
        companyName?: string;
        companyRole?: Role;
        permissions?: Permission[];
        availableCompanies?: AvailableCompany[];
      };
    }
  }
}

export {};
