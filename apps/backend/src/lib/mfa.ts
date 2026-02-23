import { Role } from '@prisma/client';
import { generateSecret, generateURI, verifySync } from 'otplib';

const MFA_ISSUER = 'SEGA Accounting';
const MFA_REQUIRED_ROLE_SET = new Set<Role>([Role.ADMIN]);

export interface MfaSetupPayload {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  accountName: string;
}

export function isMfaRequiredRole(role: Role): boolean {
  return MFA_REQUIRED_ROLE_SET.has(role);
}

export function normalizeTotpCode(code: string): string {
  return code.trim().replace(/\s+/g, '');
}

export function generateTotpSecret(): string {
  return generateSecret();
}

export function buildMfaSetupPayload(userEmail: string, secret: string): MfaSetupPayload {
  const accountName = userEmail.trim().toLowerCase();
  return {
    secret,
    otpauthUrl: generateURI({
      issuer: MFA_ISSUER,
      label: accountName,
      secret,
    }),
    issuer: MFA_ISSUER,
    accountName,
  };
}

export function verifyTotpCode(code: string, secret: string): boolean {
  try {
    const result = verifySync({
      token: normalizeTotpCode(code),
      secret,
      epochTolerance: 30,
    });
    return result.valid;
  } catch {
    return false;
  }
}
