import { OpenBankingConnectionStatus, OpenBankingSyncStatus, type OpenBankingConnection } from '@prisma/client';
import { HttpError } from '../../lib/http-error.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { round2 } from '../../utils/number.js';
import { exchangeBcrAccessToken, fetchBcrAccounts, fetchBcrTransactions } from './pilot-bcr-connector.js';
import type { OpenBankingAccountSnapshot, OpenBankingSyncSummary, OpenBankingTransactionSnapshot } from './types.js';

interface RunOpenBankingSyncInput {
  connectionId: string;
  companyId: string;
  initiatedByUserId?: string;
  fromDate?: Date;
  toDate?: Date;
  source: 'manual' | 'scheduler';
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function statementDay(value: Date): Date {
  return startOfUtcDay(value);
}

function toMapKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

function trimErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 1800);
}

async function ensureAccessToken(connection: OpenBankingConnection): Promise<OpenBankingConnection> {
  const tokenStillValid =
    connection.accessToken &&
    (!connection.tokenExpiresAt || connection.tokenExpiresAt.getTime() - Date.now() > 60 * 1000);
  if (tokenStillValid) {
    return connection;
  }

  if (!connection.refreshToken) {
    throw new Error('Conexiunea Open Banking nu are refresh token pentru reînnoirea sesiunii OAuth2.');
  }

  const refreshedToken = await exchangeBcrAccessToken({
    grantType: 'refresh_token',
    refreshToken: connection.refreshToken,
  });

  return prisma.openBankingConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: refreshedToken.accessToken,
      refreshToken: refreshedToken.refreshToken ?? connection.refreshToken,
      tokenExpiresAt: refreshedToken.expiresAt,
      status: OpenBankingConnectionStatus.ACTIVE,
      lastErrorAt: null,
      lastErrorMessage: null,
    },
  });
}

function resolveSyncWindow(connection: OpenBankingConnection, input: RunOpenBankingSyncInput): { from: Date; to: Date } {
  const to = input.toDate ?? new Date();
  if (Number.isNaN(to.getTime())) {
    throw HttpError.badRequest('toDate invalid pentru sincronizarea Open Banking.');
  }

  const defaultFrom = connection.lastCursorDate ? startOfUtcDay(connection.lastCursorDate) : startOfUtcDay(addDays(to, -1));
  const from = input.fromDate ?? defaultFrom;
  if (Number.isNaN(from.getTime())) {
    throw HttpError.badRequest('fromDate invalid pentru sincronizarea Open Banking.');
  }
  if (from > to) {
    throw HttpError.badRequest('fromDate trebuie să fie <= toDate.');
  }

  return { from, to };
}

function pickAccounts(
  connection: OpenBankingConnection,
  accounts: OpenBankingAccountSnapshot[],
): OpenBankingAccountSnapshot[] {
  if (!connection.externalAccountId) {
    return accounts;
  }

  return accounts.filter((account) => account.externalAccountId === connection.externalAccountId || account.iban === connection.externalAccountId);
}

function groupTransactionsByStatementDay(transactions: OpenBankingTransactionSnapshot[]): Map<string, OpenBankingTransactionSnapshot[]> {
  const grouped = new Map<string, OpenBankingTransactionSnapshot[]>();
  for (const transaction of transactions) {
    const day = statementDay(transaction.bookingDate);
    const key = toMapKey(day);
    const current = grouped.get(key) ?? [];
    current.push(transaction);
    grouped.set(key, current);
  }
  return grouped;
}

async function readExistingExternalTransactionIds(companyId: string, externalIds: string[]): Promise<Set<string>> {
  if (externalIds.length === 0) {
    return new Set<string>();
  }

  const existing = await prisma.bankStatementLine.findMany({
    where: {
      companyId,
      externalTransactionId: {
        in: externalIds,
      },
    },
    select: {
      externalTransactionId: true,
    },
  });

  return new Set(existing.map((entry) => entry.externalTransactionId).filter((entry): entry is string => Boolean(entry)));
}

async function importAccountTransactions(params: {
  connection: OpenBankingConnection;
  account: OpenBankingAccountSnapshot;
  transactions: OpenBankingTransactionSnapshot[];
  syncFrom: Date;
  syncTo: Date;
}): Promise<{ statementsImported: number; transactionsImported: number; latestTransactionDate?: Date }> {
  const scopedTransactions = params.transactions.filter((transaction) => transaction.bookingDate >= params.syncFrom && transaction.bookingDate <= params.syncTo);
  if (scopedTransactions.length === 0) {
    return {
      statementsImported: 0,
      transactionsImported: 0,
    };
  }

  const externalIds = scopedTransactions
    .map((transaction) => transaction.externalTransactionId)
    .filter((externalId): externalId is string => Boolean(externalId));
  const existingIds = await readExistingExternalTransactionIds(params.connection.companyId, externalIds);
  const freshTransactions = scopedTransactions.filter(
    (transaction) => !transaction.externalTransactionId || !existingIds.has(transaction.externalTransactionId),
  );

  if (freshTransactions.length === 0) {
    return {
      statementsImported: 0,
      transactionsImported: 0,
      latestTransactionDate: scopedTransactions.at(-1)?.bookingDate,
    };
  }

  const grouped = groupTransactionsByStatementDay(freshTransactions);
  let statementsImported = 0;
  let transactionsImported = 0;

  for (const [dayKey, dayTransactions] of grouped.entries()) {
    const day = new Date(`${dayKey}T00:00:00.000Z`);
    const sourceLabel = `OPEN_BANKING:${params.connection.bankCode.toUpperCase()}`;

    const existingStatement = await prisma.bankStatement.findFirst({
      where: {
        companyId: params.connection.companyId,
        accountCode: params.connection.accountCode,
        externalAccountId: params.account.externalAccountId,
        statementDate: day,
        sourceLabel,
      },
      select: {
        id: true,
      },
    });

    const statement =
      existingStatement ??
      (await prisma.bankStatement.create({
        data: {
          companyId: params.connection.companyId,
          accountCode: params.connection.accountCode,
          externalAccountId: params.account.externalAccountId,
          statementDate: day,
          currency: params.account.currency,
          closingBalance: params.account.balance ?? undefined,
          sourceLabel,
          uploadedById: params.connection.createdById,
        },
        select: {
          id: true,
        },
      }));

    if (!existingStatement) {
      statementsImported += 1;
    }

    await prisma.bankStatementLine.createMany({
      data: dayTransactions.map((transaction) => ({
        companyId: params.connection.companyId,
        statementId: statement.id,
        externalTransactionId: transaction.externalTransactionId,
        date: transaction.bookingDate,
        amount: round2(transaction.amount),
        description: transaction.description,
        reference: transaction.reference,
        counterpartyName: transaction.counterpartyName,
        counterpartyIban: transaction.counterpartyIban,
      })),
      skipDuplicates: true,
    });

    transactionsImported += dayTransactions.length;
  }

  const latestTransactionDate = freshTransactions.reduce(
    (latest, transaction) => (transaction.bookingDate > latest ? transaction.bookingDate : latest),
    freshTransactions[0]!.bookingDate,
  );

  return {
    statementsImported,
    transactionsImported,
    latestTransactionDate,
  };
}

export async function runOpenBankingSync(input: RunOpenBankingSyncInput): Promise<OpenBankingSyncSummary> {
  const connection = await prisma.openBankingConnection.findFirst({
    where: {
      id: input.connectionId,
      companyId: input.companyId,
    },
  });

  if (!connection) {
    throw HttpError.notFound('Conexiunea Open Banking nu există.');
  }

  if (connection.status === OpenBankingConnectionStatus.DISABLED) {
    throw HttpError.conflict('Conexiunea Open Banking este dezactivată.');
  }

  const syncWindow = resolveSyncWindow(connection, input);
  const syncRun = await prisma.openBankingSyncRun.create({
    data: {
      connectionId: connection.id,
      companyId: connection.companyId,
      initiatedByUserId: input.initiatedByUserId,
      status: OpenBankingSyncStatus.RUNNING,
      cursorFrom: syncWindow.from,
      cursorTo: syncWindow.to,
    },
  });

  try {
    const activeConnection = await ensureAccessToken(connection);
    if (!activeConnection.accessToken) {
      throw new Error('Conexiunea Open Banking nu are access token activ.');
    }

    const accounts = await fetchBcrAccounts(activeConnection.accessToken);
    const selectedAccounts = pickAccounts(activeConnection, accounts);
    if (selectedAccounts.length === 0) {
      throw new Error('Nu există conturi eligibile pentru sincronizare pe conexiunea selectată.');
    }

    let statementsImported = 0;
    let transactionsImported = 0;
    let balancesSynced = 0;
    let latestCursorDate: Date | null = null;

    for (const account of selectedAccounts) {
      const transactions = await fetchBcrTransactions({
        accessToken: activeConnection.accessToken,
        externalAccountId: account.externalAccountId,
        fromDate: syncWindow.from,
        toDate: syncWindow.to,
      });

      const imported = await importAccountTransactions({
        connection: activeConnection,
        account,
        transactions,
        syncFrom: syncWindow.from,
        syncTo: syncWindow.to,
      });

      statementsImported += imported.statementsImported;
      transactionsImported += imported.transactionsImported;
      balancesSynced += 1;
      if (imported.latestTransactionDate && (!latestCursorDate || imported.latestTransactionDate > latestCursorDate)) {
        latestCursorDate = imported.latestTransactionDate;
      }
    }

    await prisma.openBankingConnection.update({
      where: { id: activeConnection.id },
      data: {
        status: OpenBankingConnectionStatus.ACTIVE,
        lastSyncedAt: new Date(),
        lastCursorDate: latestCursorDate ?? syncWindow.to,
        errorCount: 0,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });

    await prisma.openBankingSyncRun.update({
      where: { id: syncRun.id },
      data: {
        status: OpenBankingSyncStatus.SUCCESS,
        finishedAt: new Date(),
        statementsImported,
        transactionsImported,
        balancesSynced,
      },
    });

    logger.info('open_banking_sync_succeeded', {
      connectionId: activeConnection.id,
      companyId: activeConnection.companyId,
      source: input.source,
      statementsImported,
      transactionsImported,
      balancesSynced,
    });

    return {
      syncRunId: syncRun.id,
      connectionId: activeConnection.id,
      statementsImported,
      transactionsImported,
      balancesSynced,
      cursorFrom: syncWindow.from,
      cursorTo: syncWindow.to,
    };
  } catch (error) {
    const errorMessage = trimErrorMessage(error);

    await prisma.openBankingConnection.update({
      where: { id: connection.id },
      data: {
        status: OpenBankingConnectionStatus.ERROR,
        errorCount: {
          increment: 1,
        },
        lastErrorAt: new Date(),
        lastErrorMessage: errorMessage,
      },
    });

    await prisma.openBankingSyncRun.update({
      where: { id: syncRun.id },
      data: {
        status: OpenBankingSyncStatus.FAILED,
        finishedAt: new Date(),
        errorMessage,
      },
    });

    logger.error('open_banking_sync_failed', {
      connectionId: connection.id,
      companyId: connection.companyId,
      source: input.source,
      error: errorMessage,
    });

    throw new HttpError(502, `Sincronizarea Open Banking a eșuat: ${errorMessage}`, { expose: true });
  }
}
