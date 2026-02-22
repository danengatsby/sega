import { XMLParser } from 'fast-xml-parser';
import { round2 } from '../utils/number.js';

export type BankStatementFileFormat = 'AUTO' | 'MT940' | 'CAMT053' | 'CSV';
type ResolvedFileFormat = Exclude<BankStatementFileFormat, 'AUTO'>;

export interface ParsedBankStatementLine {
  date: Date;
  amount: number;
  description?: string;
  reference?: string;
  counterpartyName?: string;
  counterpartyIban?: string;
}

export interface ParsedBankStatementFile {
  detectedFormat: ResolvedFileFormat;
  statementDate: Date;
  currency?: string;
  openingBalance?: number;
  closingBalance?: number;
  sourceLabel: string;
  lines: ParsedBankStatementLine[];
}

export interface ParseBankStatementFileInput {
  fileName?: string;
  mimeType?: string;
  content: string;
  format?: BankStatementFileFormat;
  csvDelimiter?: string;
}

const MAX_LINES = 5000;
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;
const IBAN_REGEX = /^[A-Z]{2}[0-9A-Z]{13,32}$/;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readNode(node: unknown, key: string): unknown {
  if (!node || typeof node !== 'object') {
    return undefined;
  }

  const obj = node as Record<string, unknown>;
  if (key in obj) {
    return obj[key];
  }

  for (const [entryKey, entryValue] of Object.entries(obj)) {
    if (entryKey.endsWith(`:${key}`)) {
      return entryValue;
    }
  }

  return undefined;
}

function readText(node: unknown): string | undefined {
  if (node === undefined || node === null) {
    return undefined;
  }

  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    const value = String(node).trim();
    return value.length > 0 ? value : undefined;
  }

  if (typeof node === 'object') {
    const objectNode = node as Record<string, unknown>;
    for (const key of ['#text', '_text', '__text']) {
      const value = objectNode[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const trimmed = String(value).trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return undefined;
}

function normalizeWhitespace(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIban(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (compact.length === 0) {
    return undefined;
  }

  if (!IBAN_REGEX.test(compact)) {
    throw new Error(`IBAN invalid: ${value}`);
  }

  return compact;
}

function parseDateFromParts(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Data invalidă: ${year}-${month}-${day}`);
  }
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new Error(`Data este în afara intervalului permis: ${year}-${month}-${day}`);
  }
  return date;
}

function parseFlexibleDate(value: string): Date {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Data lipsă.');
  }

  if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  const dotMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dotMatch) {
    return parseDateFromParts(Number(dotMatch[3]), Number(dotMatch[2]), Number(dotMatch[1]));
  }

  const slashMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slashMatch) {
    return parseDateFromParts(Number(slashMatch[3]), Number(slashMatch[2]), Number(slashMatch[1]));
  }

  const isoSlashMatch = trimmed.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (isoSlashMatch) {
    return parseDateFromParts(Number(isoSlashMatch[1]), Number(isoSlashMatch[2]), Number(isoSlashMatch[3]));
  }

  const compactMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    return parseDateFromParts(Number(compactMatch[1]), Number(compactMatch[2]), Number(compactMatch[3]));
  }

  throw new Error(`Format dată necunoscut: ${value}`);
}

function parseYYMMDD(value: string): Date {
  const match = value.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!match) {
    throw new Error(`Format YYMMDD invalid: ${value}`);
  }

  const yy = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return parseDateFromParts(year, month, day);
}

function parseDecimal(value: string): number {
  const original = value;
  let normalized = value.trim();
  if (!normalized) {
    throw new Error('Valoare numerică lipsă.');
  }

  let negative = false;
  if (normalized.startsWith('(') && normalized.endsWith(')')) {
    negative = true;
    normalized = normalized.slice(1, -1);
  }

  normalized = normalized.replace(/\s+/g, '');
  if (normalized.startsWith('+')) {
    normalized = normalized.slice(1);
  } else if (normalized.startsWith('-')) {
    negative = !negative;
    normalized = normalized.slice(1);
  }

  const lastComma = normalized.lastIndexOf(',');
  const lastDot = normalized.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    const decimals = normalized.length - lastComma - 1;
    if (decimals >= 1 && decimals <= 3) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else {
    normalized = normalized.replace(/,/g, '');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Valoare numerică invalidă: ${original}`);
  }

  return negative ? -parsed : parsed;
}

function parseMtBalance(value: string): { amount: number; currency: string; date: Date } {
  const match = value.trim().match(/^([CD])(\d{6})([A-Z]{3})([-0-9.,]+)$/);
  if (!match) {
    throw new Error(`Format sold MT940 invalid: ${value}`);
  }

  const indicator = match[1];
  const dateRaw = match[2];
  const currencyRaw = match[3];
  const amountRaw = match[4];

  if (!indicator || !dateRaw || !currencyRaw || !amountRaw) {
    throw new Error(`Format sold MT940 invalid: ${value}`);
  }

  const sign = indicator === 'D' ? -1 : 1;
  const date = parseYYMMDD(dateRaw);
  const currency = currencyRaw.toUpperCase();
  const amount = round2(Math.abs(parseDecimal(amountRaw)) * sign);
  return { amount, currency, date };
}

function parseMt61Line(value: string): { date: Date; amount: number; reference?: string } {
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 10) {
    throw new Error(`Linie :61: MT940 invalidă: ${value}`);
  }

  let cursor = 0;
  const transactionDateRaw = compact.slice(cursor, cursor + 6);
  cursor += 6;
  const date = parseYYMMDD(transactionDateRaw);

  if (/^\d{4}$/.test(compact.slice(cursor, cursor + 4))) {
    cursor += 4;
  }

  let reverse = false;
  if (compact[cursor] === 'R') {
    reverse = true;
    cursor += 1;
  }

  const creditDebit = compact[cursor];
  if (creditDebit !== 'C' && creditDebit !== 'D') {
    throw new Error(`Indicator credit/debit invalid în :61:: ${value}`);
  }
  cursor += 1;

  if (/[A-Z]/.test(compact[cursor] ?? '')) {
    cursor += 1;
  }

  const amountStart = cursor;
  while (cursor < compact.length && /[0-9.,]/.test(compact[cursor]!)) {
    cursor += 1;
  }

  const amountRaw = compact.slice(amountStart, cursor);
  if (!amountRaw) {
    throw new Error(`Nu s-a putut extrage suma din :61:: ${value}`);
  }

  let amount = Math.abs(parseDecimal(amountRaw));
  amount = creditDebit === 'D' ? -amount : amount;
  if (reverse) {
    amount = -amount;
  }
  amount = round2(amount);

  if (/^[A-Z][A-Z0-9]{3}/.test(compact.slice(cursor, cursor + 4))) {
    cursor += 4;
  }

  const remaining = compact.slice(cursor);
  const separatorIndex = remaining.indexOf('//');
  const referenceRaw = separatorIndex >= 0 ? remaining.slice(separatorIndex + 2) : remaining;
  const reference = normalizeWhitespace(referenceRaw);

  return {
    date,
    amount,
    reference,
  };
}

function normalizeMt86Description(value: string): string | undefined {
  const collapsed = value.replace(/\?\d{2}/g, ' ').replace(/[|]/g, ' ');
  return normalizeWhitespace(collapsed);
}

function parseMt86Counterparty(value: string): { counterpartyName?: string; counterpartyIban?: string } {
  const nameMatch = value.match(/(?:\/NAME\/|NUME[:=]|BENEFICIAR[:=])([^/|?]+)/i);
  const ibanMatch = value.match(/(?:IBAN[:=\/ ]+)([A-Z0-9 ]{15,36})/i);

  return {
    counterpartyName: normalizeWhitespace(nameMatch?.[1]),
    counterpartyIban: normalizeIban(ibanMatch?.[1]),
  };
}

function parseMt940(content: string): Omit<ParsedBankStatementFile, 'sourceLabel' | 'detectedFormat'> {
  const lines = content.replace(/\r/g, '').split('\n');
  const tags: Array<{ tag: string; value: string }> = [];

  let currentTag: { tag: string; value: string } | null = null;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^:(\d{2}[A-Z]?):(.*)$/);
    if (match) {
      const tag = match[1];
      const tagValue = match[2];
      if (!tag) {
        throw new Error(`Tag MT940 invalid: ${trimmed}`);
      }
      if (currentTag) {
        tags.push(currentTag);
      }
      currentTag = { tag, value: tagValue ?? '' };
      continue;
    }

    if (currentTag) {
      currentTag.value = `${currentTag.value}\n${trimmed}`.trim();
    }
  }

  if (currentTag) {
    tags.push(currentTag);
  }

  if (tags.length === 0) {
    throw new Error('Fișierul MT940 nu conține tag-uri valide.');
  }

  let openingBalance: number | undefined;
  let closingBalance: number | undefined;
  let currency: string | undefined;
  let statementDate: Date | undefined;

  const parsedLines: ParsedBankStatementLine[] = [];

  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!tag) {
      continue;
    }

    if (tag.tag === '60F' || tag.tag === '60M') {
      const parsedBalance = parseMtBalance(tag.value);
      openingBalance = parsedBalance.amount;
      currency = parsedBalance.currency;
      statementDate = statementDate ?? parsedBalance.date;
      continue;
    }

    if (tag.tag === '62F' || tag.tag === '62M') {
      const parsedBalance = parseMtBalance(tag.value);
      closingBalance = parsedBalance.amount;
      currency = parsedBalance.currency;
      statementDate = parsedBalance.date;
      continue;
    }

    if (tag.tag !== '61') {
      continue;
    }

    const parsed61 = parseMt61Line(tag.value);
    const nextTag = tags[index + 1];
    const parsed86 = nextTag?.tag === '86' ? normalizeMt86Description(nextTag.value) : undefined;
    const counterparty = nextTag?.tag === '86' ? parseMt86Counterparty(nextTag.value) : {};

    parsedLines.push({
      date: parsed61.date,
      amount: parsed61.amount,
      description: parsed86,
      reference: parsed61.reference,
      counterpartyName: counterparty.counterpartyName,
      counterpartyIban: counterparty.counterpartyIban,
    });
  }

  if (parsedLines.length === 0) {
    throw new Error('Fișierul MT940 nu conține tranzacții (:61:).');
  }

  const maxDate = parsedLines.reduce((max, line) => (line.date > max ? line.date : max), parsedLines[0]!.date);

  return {
    statementDate: statementDate ?? maxDate,
    currency,
    openingBalance,
    closingBalance,
    lines: parsedLines,
  };
}

function readAmountWithCurrency(node: unknown): { amount: number; currency?: string } {
  if (node === undefined || node === null) {
    throw new Error('Nodul de sumă lipsește.');
  }

  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return {
      amount: parseDecimal(String(node)),
    };
  }

  const objectNode = node as Record<string, unknown>;
  const currency = typeof objectNode['@_Ccy'] === 'string' ? String(objectNode['@_Ccy']).toUpperCase() : undefined;
  const value = readText(objectNode);
  if (!value) {
    throw new Error('Nu s-a putut extrage valoarea numerică din nodul de sumă.');
  }

  return {
    amount: parseDecimal(value),
    currency,
  };
}

function parseCamt053(content: string): Omit<ParsedBankStatementFile, 'sourceLabel' | 'detectedFormat'> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
  });

  const parsedXml = parser.parse(content) as Record<string, unknown>;
  const documentNode = readNode(parsedXml, 'Document') ?? parsedXml;
  const bkToCustomerStatement = readNode(documentNode, 'BkToCstmrStmt');
  const statementNode = asArray(readNode(bkToCustomerStatement, 'Stmt'))[0];

  if (!statementNode) {
    throw new Error('Fișier CAMT.053 invalid: nodul Stmt lipsește.');
  }

  let statementCurrency: string | undefined;
  let openingBalance: number | undefined;
  let closingBalance: number | undefined;

  const balances = asArray(readNode(statementNode, 'Bal'));
  for (const balance of balances) {
    const code = readText(readNode(readNode(readNode(balance, 'Tp'), 'CdOrPrtry'), 'Cd'))?.toUpperCase();
    const amountNode = readNode(balance, 'Amt');
    if (!amountNode) {
      continue;
    }

    const amountWithCurrency = readAmountWithCurrency(amountNode);
    statementCurrency = statementCurrency ?? amountWithCurrency.currency;

    const creditDebit = readText(readNode(balance, 'CdtDbtInd'))?.toUpperCase();
    const signedAmount =
      creditDebit === 'DBIT' ? -Math.abs(amountWithCurrency.amount) : Math.abs(amountWithCurrency.amount);

    if (code === 'OPBD' || code === 'ITBD') {
      openingBalance = round2(signedAmount);
    } else if (code === 'CLBD') {
      closingBalance = round2(signedAmount);
    }
  }

  const entries = asArray(readNode(statementNode, 'Ntry'));
  if (entries.length === 0) {
    throw new Error('Fișierul CAMT.053 nu conține tranzacții (Ntry).');
  }

  const parsedLines: ParsedBankStatementLine[] = [];
  for (const entry of entries) {
    const amountNode = readNode(entry, 'Amt');
    if (!amountNode) {
      continue;
    }

    const amountWithCurrency = readAmountWithCurrency(amountNode);
    statementCurrency = statementCurrency ?? amountWithCurrency.currency;
    const creditDebit = readText(readNode(entry, 'CdtDbtInd'))?.toUpperCase();
    const amount = round2(creditDebit === 'DBIT' ? -Math.abs(amountWithCurrency.amount) : Math.abs(amountWithCurrency.amount));
    if (amount === 0) {
      continue;
    }

    const bookingDateRaw =
      readText(readNode(readNode(entry, 'BookgDt'), 'Dt')) ??
      readText(readNode(readNode(entry, 'BookgDt'), 'DtTm')) ??
      readText(readNode(readNode(entry, 'ValDt'), 'Dt')) ??
      readText(readNode(readNode(entry, 'ValDt'), 'DtTm'));

    if (!bookingDateRaw) {
      throw new Error('CAMT.053 conține tranzacție fără BookgDt/ValDt.');
    }
    const bookingDate = parseFlexibleDate(bookingDateRaw);

    const ntryDetails = asArray(readNode(entry, 'NtryDtls'));
    const txDetails = ntryDetails.flatMap((detail) => asArray(readNode(detail, 'TxDtls')));
    const firstTx = txDetails[0];

    const reference =
      readText(readNode(entry, 'NtryRef')) ??
      readText(readNode(readNode(firstTx, 'Refs'), 'EndToEndId')) ??
      readText(readNode(readNode(firstTx, 'Refs'), 'AcctSvcrRef')) ??
      readText(readNode(readNode(firstTx, 'Refs'), 'TxId'));

    const remittanceInfoNode = readNode(firstTx, 'RmtInf');
    const remittanceText = asArray(readNode(remittanceInfoNode, 'Ustrd'))
      .map((part) => readText(part))
      .filter((part): part is string => Boolean(part))
      .join(' | ');

    const description = normalizeWhitespace(readText(readNode(entry, 'AddtlNtryInf')) ?? remittanceText);

    const relatedParties = readNode(firstTx, 'RltdPties');
    const relatedAccounts = readNode(firstTx, 'RltdAgts') ?? readNode(firstTx, 'RltdPties');

    const debtorName = readText(readNode(readNode(relatedParties, 'Dbtr'), 'Nm'));
    const creditorName = readText(readNode(readNode(relatedParties, 'Cdtr'), 'Nm'));
    const debtorIban = readText(readNode(readNode(readNode(relatedParties, 'DbtrAcct'), 'Id'), 'IBAN'));
    const creditorIban = readText(readNode(readNode(readNode(relatedParties, 'CdtrAcct'), 'Id'), 'IBAN'));
    const fallbackIban = readText(readNode(readNode(readNode(relatedAccounts, 'CdtrAcct'), 'Id'), 'IBAN'));

    const counterpartyName = amount > 0 ? debtorName ?? creditorName : creditorName ?? debtorName;
    const counterpartyIban = normalizeIban(amount > 0 ? debtorIban ?? creditorIban : creditorIban ?? debtorIban ?? fallbackIban);

    parsedLines.push({
      date: bookingDate,
      amount,
      description,
      reference: normalizeWhitespace(reference),
      counterpartyName: normalizeWhitespace(counterpartyName),
      counterpartyIban,
    });
  }

  if (parsedLines.length === 0) {
    throw new Error('Fișierul CAMT.053 nu conține tranzacții mapabile.');
  }

  const statementDate = parsedLines.reduce((max, line) => (line.date > max ? line.date : max), parsedLines[0]!.date);
  return {
    statementDate,
    currency: statementCurrency,
    openingBalance,
    closingBalance,
    lines: parsedLines,
  };
}

function parseCsvRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    const next = content[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(field);
      if (row.some((cell) => cell.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((cell) => cell.trim().length > 0)) {
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '');
}

function detectCsvDelimiter(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t'];
  const scored = candidates.map((candidate) => ({
    delimiter: candidate,
    count: firstLine.split(candidate).length - 1,
  }));
  scored.sort((left, right) => right.count - left.count);
  return scored[0]?.count && scored[0].count > 0 ? scored[0].delimiter : ',';
}

function parseCsv(
  content: string,
  options: {
    delimiter?: string;
  },
): Omit<ParsedBankStatementFile, 'sourceLabel' | 'detectedFormat'> {
  const delimiter = options.delimiter ?? detectCsvDelimiter(content);
  const rows = parseCsvRows(content, delimiter);
  if (rows.length < 2) {
    throw new Error('CSV invalid: fișierul trebuie să conțină header și cel puțin o linie.');
  }

  const headers = rows[0]!.map((cell) => normalizeHeader(cell));
  const lines = rows.slice(1);

  const headerAliases = {
    date: ['date', 'bookingdate', 'valuedate', 'transactiondate', 'data', 'datatranzactie', 'dataoperatie'],
    amount: ['amount', 'sum', 'suma', 'valoare', 'transactionamount'],
    description: ['description', 'detalii', 'details', 'narrative', 'explanation'],
    reference: ['reference', 'ref', 'document', 'documentnumber', 'paymentreference'],
    counterpartyName: ['counterparty', 'counterpartyname', 'partener', 'beneficiary', 'payer', 'name', 'partnername'],
    counterpartyIban: ['counterpartyiban', 'iban', 'beneficiaryiban', 'payeriban', 'partneriban'],
    currency: ['currency', 'ccy', 'moneda'],
  } as const;

  function findColumn(column: keyof typeof headerAliases): number {
    const aliases = headerAliases[column] as readonly string[];
    return headers.findIndex((header) => aliases.includes(header));
  }

  const dateIndex = findColumn('date');
  const amountIndex = findColumn('amount');
  if (dateIndex < 0 || amountIndex < 0) {
    throw new Error('CSV invalid: coloanele obligatorii date și amount lipsesc.');
  }

  const descriptionIndex = findColumn('description');
  const referenceIndex = findColumn('reference');
  const counterpartyNameIndex = findColumn('counterpartyName');
  const counterpartyIbanIndex = findColumn('counterpartyIban');
  const currencyIndex = findColumn('currency');

  const parsedLines: ParsedBankStatementLine[] = [];
  let discoveredCurrency: string | undefined;

  for (let rowIndex = 0; rowIndex < lines.length; rowIndex += 1) {
    const row = lines[rowIndex]!;
    const dateRaw = row[dateIndex]?.trim();
    const amountRaw = row[amountIndex]?.trim();
    if (!dateRaw || !amountRaw) {
      continue;
    }

    const date = parseFlexibleDate(dateRaw);
    const amount = round2(parseDecimal(amountRaw));
    if (amount === 0) {
      continue;
    }

    const currencyRaw = currencyIndex >= 0 ? row[currencyIndex]?.trim().toUpperCase() : undefined;
    if (currencyRaw) {
      if (!/^[A-Z]{3}$/.test(currencyRaw)) {
        throw new Error(`Monedă invalidă la linia ${rowIndex + 2}: ${currencyRaw}`);
      }
      discoveredCurrency = discoveredCurrency ?? currencyRaw;
    }

    parsedLines.push({
      date,
      amount,
      description: normalizeWhitespace(descriptionIndex >= 0 ? row[descriptionIndex] : undefined),
      reference: normalizeWhitespace(referenceIndex >= 0 ? row[referenceIndex] : undefined),
      counterpartyName: normalizeWhitespace(counterpartyNameIndex >= 0 ? row[counterpartyNameIndex] : undefined),
      counterpartyIban: normalizeIban(counterpartyIbanIndex >= 0 ? row[counterpartyIbanIndex] : undefined),
    });
  }

  if (parsedLines.length === 0) {
    throw new Error('CSV invalid: nu există tranzacții mapabile.');
  }

  const statementDate = parsedLines.reduce((max, line) => (line.date > max ? line.date : max), parsedLines[0]!.date);

  return {
    statementDate,
    currency: discoveredCurrency,
    lines: parsedLines,
  };
}

function resolveFormat(input: ParseBankStatementFileInput): ResolvedFileFormat {
  const explicitFormat = input.format ?? 'AUTO';
  if (explicitFormat !== 'AUTO') {
    return explicitFormat;
  }

  const fileName = (input.fileName ?? '').toLowerCase();
  if (fileName.endsWith('.xml')) {
    return 'CAMT053';
  }
  if (fileName.endsWith('.csv')) {
    return 'CSV';
  }
  if (fileName.endsWith('.mt940') || fileName.endsWith('.sta')) {
    return 'MT940';
  }

  const mimeType = (input.mimeType ?? '').toLowerCase();
  if (mimeType.includes('xml')) {
    return 'CAMT053';
  }
  if (mimeType.includes('csv')) {
    return 'CSV';
  }

  const sample = input.content.slice(0, 4096);
  if (/<(?:\w+:)?BkToCstmrStmt\b/.test(sample) || /<(?:\w+:)?Document\b/.test(sample)) {
    return 'CAMT053';
  }
  if (/:61:/.test(sample) && /:62[FM]:/.test(sample)) {
    return 'MT940';
  }

  return 'CSV';
}

function sanitizeLines(lines: ParsedBankStatementLine[]): ParsedBankStatementLine[] {
  if (lines.length === 0) {
    throw new Error('Extrasul nu conține tranzacții.');
  }

  if (lines.length > MAX_LINES) {
    throw new Error(`Extrasul conține ${lines.length} linii. Limita maximă este ${MAX_LINES}.`);
  }

  return lines.map((line, index) => {
    if (!Number.isFinite(line.amount) || line.amount === 0) {
      throw new Error(`Linia ${index + 1} are sumă invalidă.`);
    }
    if (Number.isNaN(line.date.getTime())) {
      throw new Error(`Linia ${index + 1} are dată invalidă.`);
    }

    return {
      date: line.date,
      amount: round2(line.amount),
      description: normalizeWhitespace(line.description),
      reference: normalizeWhitespace(line.reference),
      counterpartyName: normalizeWhitespace(line.counterpartyName),
      counterpartyIban: normalizeIban(line.counterpartyIban),
    };
  });
}

export function parseBankStatementFile(input: ParseBankStatementFileInput): ParsedBankStatementFile {
  const content = input.content.replace(/^\uFEFF/, '').trim();
  if (!content) {
    throw new Error('Fișierul extras este gol.');
  }

  const detectedFormat = resolveFormat(input);
  let parsed: Omit<ParsedBankStatementFile, 'detectedFormat' | 'sourceLabel'>;

  switch (detectedFormat) {
    case 'MT940':
      parsed = parseMt940(content);
      break;
    case 'CAMT053':
      parsed = parseCamt053(content);
      break;
    case 'CSV':
      parsed = parseCsv(content, { delimiter: input.csvDelimiter });
      break;
    default:
      throw new Error(`Format fișier neacceptat: ${detectedFormat}`);
  }

  const sanitizedLines = sanitizeLines(parsed.lines);
  const statementDate = parsed.statementDate;
  if (Number.isNaN(statementDate.getTime())) {
    throw new Error('Data extrasului este invalidă.');
  }

  if (parsed.currency && !/^[A-Z]{3}$/.test(parsed.currency.toUpperCase())) {
    throw new Error(`Monedă invalidă în extras: ${parsed.currency}`);
  }

  return {
    detectedFormat,
    statementDate,
    currency: parsed.currency?.toUpperCase(),
    openingBalance: parsed.openingBalance !== undefined ? round2(parsed.openingBalance) : undefined,
    closingBalance: parsed.closingBalance !== undefined ? round2(parsed.closingBalance) : undefined,
    sourceLabel: `${detectedFormat}:${input.fileName ?? 'uploaded-file'}`,
    lines: sanitizedLines,
  };
}
