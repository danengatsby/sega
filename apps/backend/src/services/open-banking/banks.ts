export const OPEN_BANKING_BANK_CODES = ['BCR', 'BRD', 'ING', 'RAIFFEISEN', 'UNICREDIT'] as const;

export type OpenBankingBankCode = (typeof OPEN_BANKING_BANK_CODES)[number];

export const OPEN_BANKING_PROVIDER_NAME: Record<OpenBankingBankCode, string> = {
  BCR: 'BCR George Open Banking',
  BRD: 'BRD Open Banking',
  ING: 'ING Open Banking',
  RAIFFEISEN: 'Raiffeisen Open Banking',
  UNICREDIT: 'UniCredit Open Banking',
};

export function isOpenBankingBankCode(value: unknown): value is OpenBankingBankCode {
  return typeof value === 'string' && OPEN_BANKING_BANK_CODES.includes(value as OpenBankingBankCode);
}

export function parseOpenBankingBankCode(value: unknown): OpenBankingBankCode | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return isOpenBankingBankCode(normalized) ? normalized : null;
}

export function providerNameForBankCode(bankCode: OpenBankingBankCode): string {
  return OPEN_BANKING_PROVIDER_NAME[bankCode];
}
