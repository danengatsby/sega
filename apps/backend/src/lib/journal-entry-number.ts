import type { Prisma } from '@prisma/client';

type JournalEntryNumberClient = Pick<Prisma.TransactionClient, 'journalEntry'>;

export function formatJournalEntryNumber(year: number, sequence: number): string {
  return `NC-${year}-${String(sequence).padStart(6, '0')}`;
}

export async function nextJournalEntryNumber(
  db: JournalEntryNumberClient,
  companyId: string,
  date: Date,
): Promise<string> {
  const year = date.getUTCFullYear();
  const prefix = `NC-${year}-`;
  const lastEntry = await db.journalEntry.findFirst({
    where: {
      companyId,
      number: {
        startsWith: prefix,
      },
    },
    select: {
      number: true,
    },
    orderBy: {
      number: 'desc',
    },
  });

  const lastSequence = (() => {
    if (!lastEntry?.number) {
      return 0;
    }

    const parts = lastEntry.number.split('-');
    if (parts.length !== 3) {
      return 0;
    }

    const parsed = Number.parseInt(parts[2] ?? '0', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  })();

  return formatJournalEntryNumber(year, lastSequence + 1);
}
