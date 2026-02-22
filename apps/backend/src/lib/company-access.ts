import { Role } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from './prisma.js';
import type { Permission } from './rbac.js';
import { permissionsForRole } from './rbac.js';

const DEFAULT_COMPANY_CODE = 'default';
const DEFAULT_COMPANY_NAME = 'Compania implicită';

export interface AvailableCompany {
  id: string;
  code: string;
  name: string;
  role: Role;
  isDefault: boolean;
}

export interface CompanyAccessContext {
  companyId: string;
  companyCode: string;
  companyName: string;
  role: Role;
  permissions: Permission[];
  availableCompanies: AvailableCompany[];
}

function normalizeCompanyId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readRequestedCompanyId(req: Request): string | null {
  const headerValue = req.headers['x-company-id'];
  const headerCompanyId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  const queryValue = req.query.companyId;
  const queryCompanyId = Array.isArray(queryValue) ? queryValue[0] : queryValue;

  return normalizeCompanyId(headerCompanyId ?? (typeof queryCompanyId === 'string' ? queryCompanyId : null));
}

async function ensureFallbackCompany() {
  const existingCompany = await prisma.company.findFirst({
    where: {
      isActive: true,
    },
    orderBy: [{ createdAt: 'asc' }],
  });

  if (existingCompany) {
    return existingCompany;
  }

  return prisma.company.upsert({
    where: { code: DEFAULT_COMPANY_CODE },
    update: {
      isActive: true,
      name: DEFAULT_COMPANY_NAME,
    },
    create: {
      code: DEFAULT_COMPANY_CODE,
      name: DEFAULT_COMPANY_NAME,
      isActive: true,
    },
  });
}

export async function ensureUserHasCompanyMembership(userId: string, fallbackRole: Role): Promise<void> {
  const existingMembership = await prisma.userCompanyMembership.findFirst({
    where: { userId },
    select: { id: true },
  });

  if (existingMembership) {
    return;
  }

  const fallbackCompany = await ensureFallbackCompany();

  await prisma.userCompanyMembership.upsert({
    where: {
      userId_companyId: {
        userId,
        companyId: fallbackCompany.id,
      },
    },
    update: {
      role: fallbackRole,
      isDefault: true,
    },
    create: {
      userId,
      companyId: fallbackCompany.id,
      role: fallbackRole,
      isDefault: true,
    },
  });
}

export async function resolveUserCompanyAccessContext(
  userId: string,
  requestedCompanyId: string | null,
): Promise<CompanyAccessContext | null> {
  const memberships = await prisma.userCompanyMembership.findMany({
    where: {
      userId,
      company: {
        isActive: true,
      },
    },
    include: {
      company: {
        select: {
          id: true,
          code: true,
          name: true,
          isActive: true,
        },
      },
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  if (memberships.length === 0) {
    return null;
  }

  const selectedMembership = requestedCompanyId
    ? memberships.find((membership) => membership.companyId === requestedCompanyId)
    : memberships.find((membership) => membership.isDefault) ?? memberships[0];

  if (!selectedMembership) {
    return null;
  }

  const availableCompanies: AvailableCompany[] = memberships.map((membership) => ({
    id: membership.company.id,
    code: membership.company.code,
    name: membership.company.name,
    role: membership.role,
    isDefault: membership.isDefault,
  }));

  return {
    companyId: selectedMembership.company.id,
    companyCode: selectedMembership.company.code,
    companyName: selectedMembership.company.name,
    role: selectedMembership.role,
    permissions: permissionsForRole(selectedMembership.role),
    availableCompanies,
  };
}

