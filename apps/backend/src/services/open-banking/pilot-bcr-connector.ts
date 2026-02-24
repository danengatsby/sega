import { env } from '../../config/env.js';
import type {
  OAuthTokenExchangeResult,
  OpenBankingAccountSnapshot,
  OpenBankingTransactionSnapshot,
} from './types.js';
import type { OpenBankingBankCode } from './banks.js';

interface OpenBankingConnectorConfig {
  tokenUrl: string;
  accountsUrl: string;
  transactionsUrl: string;
  clientId: string;
  clientSecret: string;
}

type FetchImpl = typeof fetch;

interface ExchangeAccessTokenInput {
  bankCode: OpenBankingBankCode;
  grantType: 'authorization_code' | 'refresh_token';
  code?: string;
  redirectUri?: string;
  refreshToken?: string;
}

interface FetchTransactionsInput {
  bankCode: OpenBankingBankCode;
  accessToken: string;
  externalAccountId: string;
  fromDate: Date;
  toDate: Date;
}

interface ConnectorEnvConfig {
  tokenUrl: string | undefined;
  accountsUrl: string | undefined;
  transactionsUrl: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
}

const connectorEnvByBank: Record<OpenBankingBankCode, ConnectorEnvConfig> = {
  BCR: {
    tokenUrl: env.OPEN_BANKING_BCR_TOKEN_URL,
    accountsUrl: env.OPEN_BANKING_BCR_ACCOUNTS_URL,
    transactionsUrl: env.OPEN_BANKING_BCR_TRANSACTIONS_URL,
    clientId: env.OPEN_BANKING_BCR_CLIENT_ID,
    clientSecret: env.OPEN_BANKING_BCR_CLIENT_SECRET,
  },
  BRD: {
    tokenUrl: env.OPEN_BANKING_BRD_TOKEN_URL,
    accountsUrl: env.OPEN_BANKING_BRD_ACCOUNTS_URL,
    transactionsUrl: env.OPEN_BANKING_BRD_TRANSACTIONS_URL,
    clientId: env.OPEN_BANKING_BRD_CLIENT_ID,
    clientSecret: env.OPEN_BANKING_BRD_CLIENT_SECRET,
  },
  ING: {
    tokenUrl: env.OPEN_BANKING_ING_TOKEN_URL,
    accountsUrl: env.OPEN_BANKING_ING_ACCOUNTS_URL,
    transactionsUrl: env.OPEN_BANKING_ING_TRANSACTIONS_URL,
    clientId: env.OPEN_BANKING_ING_CLIENT_ID,
    clientSecret: env.OPEN_BANKING_ING_CLIENT_SECRET,
  },
  RAIFFEISEN: {
    tokenUrl: env.OPEN_BANKING_RAIFFEISEN_TOKEN_URL,
    accountsUrl: env.OPEN_BANKING_RAIFFEISEN_ACCOUNTS_URL,
    transactionsUrl: env.OPEN_BANKING_RAIFFEISEN_TRANSACTIONS_URL,
    clientId: env.OPEN_BANKING_RAIFFEISEN_CLIENT_ID,
    clientSecret: env.OPEN_BANKING_RAIFFEISEN_CLIENT_SECRET,
  },
  UNICREDIT: {
    tokenUrl: env.OPEN_BANKING_UNICREDIT_TOKEN_URL,
    accountsUrl: env.OPEN_BANKING_UNICREDIT_ACCOUNTS_URL,
    transactionsUrl: env.OPEN_BANKING_UNICREDIT_TRANSACTIONS_URL,
    clientId: env.OPEN_BANKING_UNICREDIT_CLIENT_ID,
    clientSecret: env.OPEN_BANKING_UNICREDIT_CLIENT_SECRET,
  },
};

function resolveConfig(bankCode: OpenBankingBankCode): OpenBankingConnectorConfig {
  const bankLabel = bankCode.toUpperCase();
  const config = connectorEnvByBank[bankCode];
  const tokenUrl = config.tokenUrl;
  const accountsUrl = config.accountsUrl;
  const transactionsUrl = config.transactionsUrl;
  const clientId = config.clientId;
  const clientSecret = config.clientSecret;

  if (!tokenUrl || !accountsUrl || !transactionsUrl) {
    throw new Error(`Configurația Open Banking ${bankLabel} este incompletă (URL-uri lipsă).`);
  }
  if (!clientId || !clientSecret) {
    throw new Error(`Configurația Open Banking ${bankLabel} este incompletă (client credentials lipsă).`);
  }

  return {
    tokenUrl,
    accountsUrl,
    transactionsUrl,
    clientId,
    clientSecret,
  };
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
}

function readDeep(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    const objectNode = asObject(current);
    if (!objectNode) {
      return undefined;
    }
    current = objectNode[part];
  }
  return current;
}

function pickFirst(source: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const value = readDeep(source, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function normalizeIban(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9A-Z]{13,32}$/.test(compact)) {
    return undefined;
  }
  return compact;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, '').replace(',', '.');
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return undefined;
}

function toIsoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return asObject(parsed) ?? {};
  } catch {
    return {};
  }
}

function parseAccountsPayload(payload: unknown): OpenBankingAccountSnapshot[] {
  const rawAccounts = pickFirst(payload, ['accounts', 'data.accounts', 'data.items', 'items']);
  const accounts = asArray(rawAccounts);

  const snapshots: OpenBankingAccountSnapshot[] = [];
  for (const raw of accounts) {
    const account = asObject(raw);
    if (!account) {
      continue;
    }

    const externalAccountId =
      toStringOrUndefined(account.id) ??
      toStringOrUndefined(account.accountId) ??
      toStringOrUndefined(account.resourceId) ??
      normalizeIban(toStringOrUndefined(account.iban));
    if (!externalAccountId) {
      continue;
    }

    const currency =
      toStringOrUndefined(account.currency) ??
      toStringOrUndefined(readDeep(account, 'balance.currency')) ??
      toStringOrUndefined(readDeep(account, 'balances.current.currency')) ??
      'RON';

    const balance =
      toNumber(account.balance) ??
      toNumber(readDeep(account, 'balance.amount')) ??
      toNumber(readDeep(account, 'balances.current.amount')) ??
      toNumber(readDeep(account, 'balances.available.amount'));

    snapshots.push({
      externalAccountId,
      iban: normalizeIban(toStringOrUndefined(account.iban) ?? toStringOrUndefined(account.accountNumber)),
      currency: currency.toUpperCase(),
      balance,
      name: toStringOrUndefined(account.name),
    });
  }

  return snapshots;
}

function parseTransactionAmount(transaction: Record<string, unknown>): { amount: number; currency: string } | null {
  const amountObject = asObject(transaction.amount) ?? asObject(readDeep(transaction, 'transactionAmount'));
  const amountValue =
    toNumber(transaction.amount) ??
    toNumber(readDeep(transaction, 'amount.value')) ??
    toNumber(amountObject?.amount) ??
    toNumber(readDeep(transaction, 'transactionAmount.amount'));

  if (amountValue === undefined || amountValue === 0) {
    return null;
  }

  const indicator = (
    toStringOrUndefined(transaction.creditDebitIndicator) ??
    toStringOrUndefined(readDeep(transaction, 'transactionAmount.creditDebitIndicator')) ??
    ''
  ).toUpperCase();
  const signedAmount = indicator === 'DBIT' || indicator === 'DEBIT' ? -Math.abs(amountValue) : Math.abs(amountValue);

  const currency =
    toStringOrUndefined(transaction.currency) ??
    toStringOrUndefined(readDeep(transaction, 'amount.currency')) ??
    toStringOrUndefined(amountObject?.currency) ??
    toStringOrUndefined(readDeep(transaction, 'transactionAmount.currency')) ??
    'RON';

  return {
    amount: Number(signedAmount.toFixed(2)),
    currency: currency.toUpperCase(),
  };
}

function parseTransactionsPayload(payload: unknown): OpenBankingTransactionSnapshot[] {
  const rawTransactions = pickFirst(payload, [
    'transactions',
    'data.transactions',
    'data.booked',
    'bookedTransactions',
    'items',
  ]);
  const transactions = asArray(rawTransactions);

  const snapshots: OpenBankingTransactionSnapshot[] = [];
  for (const raw of transactions) {
    const transaction = asObject(raw);
    if (!transaction) {
      continue;
    }

    const amount = parseTransactionAmount(transaction);
    if (!amount) {
      continue;
    }

    const bookingDate =
      toDate(transaction.bookingDate) ??
      toDate(transaction.bookingDateTime) ??
      toDate(transaction.valueDate) ??
      toDate(transaction.date);
    if (!bookingDate) {
      continue;
    }

    snapshots.push({
      externalTransactionId:
        toStringOrUndefined(transaction.id) ??
        toStringOrUndefined(transaction.transactionId) ??
        toStringOrUndefined(transaction.resourceId) ??
        toStringOrUndefined(transaction.entryReference),
      bookingDate,
      amount: amount.amount,
      currency: amount.currency,
      description:
        toStringOrUndefined(transaction.description) ??
        toStringOrUndefined(transaction.remittanceInformationUnstructured) ??
        toStringOrUndefined(readDeep(transaction, 'remittanceInformation.unstructured')),
      reference:
        toStringOrUndefined(transaction.reference) ??
        toStringOrUndefined(transaction.endToEndId) ??
        toStringOrUndefined(transaction.transactionId),
      counterpartyName:
        toStringOrUndefined(transaction.counterpartyName) ??
        toStringOrUndefined(transaction.creditorName) ??
        toStringOrUndefined(transaction.debtorName),
      counterpartyIban: normalizeIban(
        toStringOrUndefined(transaction.counterpartyIban) ??
          toStringOrUndefined(transaction.creditorAccountIban) ??
          toStringOrUndefined(transaction.debtorAccountIban),
      ),
    });
  }

  return snapshots.sort((left, right) => left.bookingDate.getTime() - right.bookingDate.getTime());
}

function applyTransactionsUrlTemplate(url: string, externalAccountId: string): string {
  return url.replace('{accountId}', encodeURIComponent(externalAccountId));
}

export async function exchangeOpenBankingAccessToken(
  input: ExchangeAccessTokenInput,
  options: { fetchImpl?: FetchImpl } = {},
): Promise<OAuthTokenExchangeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = resolveConfig(input.bankCode);

  const body = new URLSearchParams();
  body.set('grant_type', input.grantType);
  body.set('client_id', config.clientId);
  body.set('client_secret', config.clientSecret);

  if (input.grantType === 'authorization_code') {
    if (!input.code) {
      throw new Error('authorizationCode este obligatoriu pentru grant_type=authorization_code.');
    }
    body.set('code', input.code);
    if (input.redirectUri) {
      body.set('redirect_uri', input.redirectUri);
    }
  } else {
    if (!input.refreshToken) {
      throw new Error('refreshToken este obligatoriu pentru grant_type=refresh_token.');
    }
    body.set('refresh_token', input.refreshToken);
  }

  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const message =
      toStringOrUndefined(payload.error_description) ??
      toStringOrUndefined(payload.error) ??
      `Token endpoint răspunde cu status ${response.status}`;
    throw new Error(message);
  }

  const accessToken = toStringOrUndefined(payload.access_token);
  if (!accessToken) {
    throw new Error('Token endpoint nu a returnat access_token.');
  }

  const expiresIn = toNumber(payload.expires_in);
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined;

  return {
    accessToken,
    refreshToken: toStringOrUndefined(payload.refresh_token),
    expiresAt,
    scope: toStringOrUndefined(payload.scope),
    tokenType: toStringOrUndefined(payload.token_type),
  };
}

export async function fetchOpenBankingAccounts(
  bankCode: OpenBankingBankCode,
  accessToken: string,
  options: { fetchImpl?: FetchImpl } = {},
): Promise<OpenBankingAccountSnapshot[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = resolveConfig(bankCode);

  const response = await fetchImpl(config.accountsUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const message =
      toStringOrUndefined(payload.error_description) ??
      toStringOrUndefined(payload.error) ??
      `Accounts endpoint răspunde cu status ${response.status}`;
    throw new Error(message);
  }

  const accounts = parseAccountsPayload(payload);
  if (accounts.length === 0) {
    throw new Error('Accounts endpoint nu a returnat conturi utilizabile.');
  }
  return accounts;
}

export async function fetchOpenBankingTransactions(
  input: FetchTransactionsInput,
  options: { fetchImpl?: FetchImpl } = {},
): Promise<OpenBankingTransactionSnapshot[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = resolveConfig(input.bankCode);
  const endpoint = applyTransactionsUrlTemplate(config.transactionsUrl, input.externalAccountId);
  const url = new URL(endpoint);
  url.searchParams.set('fromDate', toIsoDay(input.fromDate));
  url.searchParams.set('toDate', toIsoDay(input.toDate));

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${input.accessToken}`,
    },
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const message =
      toStringOrUndefined(payload.error_description) ??
      toStringOrUndefined(payload.error) ??
      `Transactions endpoint răspunde cu status ${response.status}`;
    throw new Error(message);
  }

  return parseTransactionsPayload(payload);
}

export async function exchangeBcrAccessToken(
  input: Omit<ExchangeAccessTokenInput, 'bankCode'>,
  options: { fetchImpl?: FetchImpl } = {},
): Promise<OAuthTokenExchangeResult> {
  return exchangeOpenBankingAccessToken(
    {
      bankCode: 'BCR',
      ...input,
    },
    options,
  );
}

export async function fetchBcrAccounts(
  accessToken: string,
  options: { fetchImpl?: FetchImpl } = {},
): Promise<OpenBankingAccountSnapshot[]> {
  return fetchOpenBankingAccounts('BCR', accessToken, options);
}

export async function fetchBcrTransactions(
  input: Omit<FetchTransactionsInput, 'bankCode'>,
  options: { fetchImpl?: FetchImpl } = {},
): Promise<OpenBankingTransactionSnapshot[]> {
  return fetchOpenBankingTransactions(
    {
      bankCode: 'BCR',
      ...input,
    },
    options,
  );
}

export const __internal = {
  parseAccountsPayload,
  parseTransactionsPayload,
  resolveConfig,
};
