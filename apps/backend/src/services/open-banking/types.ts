export interface OAuthTokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string;
  tokenType?: string;
}

export interface OpenBankingAccountSnapshot {
  externalAccountId: string;
  iban?: string;
  currency: string;
  balance?: number;
  name?: string;
}

export interface OpenBankingTransactionSnapshot {
  externalTransactionId?: string;
  bookingDate: Date;
  amount: number;
  currency: string;
  description?: string;
  reference?: string;
  counterpartyName?: string;
  counterpartyIban?: string;
}

export interface OpenBankingSyncSummary {
  syncRunId: string;
  connectionId: string;
  statementsImported: number;
  transactionsImported: number;
  balancesSynced: number;
  cursorFrom: Date;
  cursorTo: Date;
}
