import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http-error.js';
import { buildS3Uri, getObjectText, parseS3Uri, putObjectText } from '../../lib/object-storage.js';
import { xmlEscape } from '../reports/helpers.js';

export type EFacturaProcessingStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface EFacturaCompanyProfile {
  companyId: string;
  name: string;
  cui: string;
  address: string;
  iban?: string | null;
}

export interface EFacturaPartnerProfile {
  name: string;
  cui: string;
  address?: string | null;
  iban?: string | null;
}

export interface EFacturaInvoicePayload {
  invoiceId: string;
  number: string;
  issueDate: Date;
  dueDate: Date;
  currency: string;
  subtotal: number;
  vat: number;
  total: number;
  description?: string | null;
}

export interface EFacturaStatusSnapshot {
  status: EFacturaProcessingStatus;
  uploadIndex: string;
  downloadId: string | null;
  message: string | null;
  raw: unknown;
}

export interface EFacturaSubmissionResult extends EFacturaStatusSnapshot {
  signedXml: string | null;
  polls: number;
}

const DEFAULT_EFACTURA_BASE_URL = 'https://webservicesp.anaf.ro/prod/FCTEL/rest';

function normalizeCui(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function ensureCui(value: string, fieldName: string): string {
  const normalized = normalizeCui(value);
  if (!/^RO?[0-9]{2,15}$/i.test(normalized)) {
    throw HttpError.badRequest(`${fieldName} trebuie să conțină un CUI valid pentru e-Factura.`);
  }
  return normalized;
}

function amount(value: number): string {
  return value.toFixed(2);
}

function dateIso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function text(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function computeVatPercent(subtotal: number, vat: number): number {
  if (subtotal <= 0 || vat <= 0) {
    return 0;
  }
  return Math.round(((vat / subtotal) * 100 + Number.EPSILON) * 100) / 100;
}

function normalizeBaseUrl(): string {
  const raw = env.ANAF_EFACTURA_BASE_URL?.trim() || DEFAULT_EFACTURA_BASE_URL;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function buildAuthHeaders(): HeadersInit {
  if (env.ANAF_EFACTURA_MODE !== 'live') {
    return {};
  }

  const token = env.ANAF_EFACTURA_OAUTH_TOKEN?.trim();
  if (!token) {
    throw HttpError.conflict('ANAF_EFACTURA_OAUTH_TOKEN este obligatoriu pentru modul live.');
  }

  return {
    Authorization: `Bearer ${token}`,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.ANAF_EFACTURA_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function toFlatPairs(value: unknown, parentKey = ''): Array<{ key: string; value: string }> {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (parentKey.length === 0) {
      return [];
    }
    return [{ key: parentKey, value: String(value) }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => toFlatPairs(item, `${parentKey}[${index}]`));
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.entries(record).flatMap(([key, child]) => {
      const nextKey = parentKey ? `${parentKey}.${key}` : key;
      const direct =
        typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean'
          ? [{ key: nextKey, value: String(child) }]
          : [];
      return [...direct, ...toFlatPairs(child, nextKey)];
    });
  }

  return [];
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickValueFromPairs(
  pairs: Array<{ key: string; value: string }>,
  keyCandidates: string[],
): string | null {
  const normalizedCandidates = new Set(keyCandidates.map((candidate) => normalizeKey(candidate)));
  for (const pair of pairs) {
    if (normalizedCandidates.has(normalizeKey(pair.key))) {
      return pair.value;
    }
  }

  return null;
}

function pickValueFromText(textPayload: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = textPayload.match(pattern);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function payloadText(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload === null || payload === undefined) {
    return '';
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function extractUploadIndex(payload: unknown): string | null {
  const pairs = toFlatPairs(payload);
  const fromPairs = pickValueFromPairs(pairs, [
    'index_incarcare',
    'indexIncarcare',
    'upload_index',
    'uploadIndex',
  ]);
  if (fromPairs) {
    return fromPairs;
  }

  return pickValueFromText(payloadText(payload), [/(?:index[_\s-]*incarcare|upload[_\s-]*index)\D+([A-Za-z0-9_-]+)/i]);
}

function extractDownloadId(payload: unknown): string | null {
  const pairs = toFlatPairs(payload);
  const fromPairs = pickValueFromPairs(pairs, [
    'id_descarcare',
    'idDescarcare',
    'download_id',
    'downloadId',
    'idMesaj',
    'messageId',
  ]);
  if (fromPairs) {
    return fromPairs;
  }

  return pickValueFromText(payloadText(payload), [/(?:id[_\s-]*descarcare|download[_\s-]*id|message[_\s-]*id)\D+([A-Za-z0-9_-]+)/i]);
}

function extractStatusAndMessage(payload: unknown): { statusRaw: string | null; message: string | null } {
  const pairs = toFlatPairs(payload);
  const statusRaw = pickValueFromPairs(pairs, ['stare', 'status', 'statusMesaj']);
  const message =
    pickValueFromPairs(pairs, ['mesaj', 'message', 'detalii', 'details', 'eroare', 'error']) ??
    pickValueFromText(payloadText(payload), [/(?:mesaj|message|detalii|eroare|error)\D+([^",}\]]+)/i]);

  return {
    statusRaw,
    message,
  };
}

function classifyStatus(payload: unknown, statusRaw: string | null, message: string | null): EFacturaProcessingStatus {
  const normalized = `${statusRaw ?? ''} ${message ?? ''} ${payloadText(payload)}`.toUpperCase();

  if (/(NOK|RESPINS|REJECT|EROARE|ERROR|INVALID)/.test(normalized)) {
    return 'REJECTED';
  }

  if (/(OK|ACCEPTAT|ACCEPTED|VALID|INREGISTRAT|PROCESAT CU SUCCES)/.test(normalized)) {
    return 'ACCEPTED';
  }

  return 'PENDING';
}

async function anafRequest(pathnameWithQuery: string, init: RequestInit): Promise<unknown> {
  const url = `${normalizeBaseUrl()}${pathnameWithQuery}`;
  const response = await fetchWithTimeout(url, init);
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw new HttpError(502, `ANAF e-Factura a răspuns cu status ${response.status}.`, { expose: true });
  }

  return payload;
}

export function buildEfacturaInvoiceXml(
  invoice: EFacturaInvoicePayload,
  supplier: EFacturaCompanyProfile,
  customer: EFacturaPartnerProfile,
): string {
  const supplierCui = ensureCui(supplier.cui, 'CUI furnizor');
  const customerCui = ensureCui(customer.cui, 'CUI client');
  const supplierName = text(supplier.name, 'Furnizor');
  const supplierAddress = text(supplier.address, 'Romania');
  const customerName = text(customer.name, 'Client');
  const customerAddress = text(customer.address, 'Romania');
  const description = text(invoice.description, `Factura ${invoice.number}`);
  const vatPercent = computeVatPercent(invoice.subtotal, invoice.vat);

  const lineAmount = amount(invoice.subtotal);
  const taxAmount = amount(invoice.vat);
  const totalAmount = amount(invoice.total);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:fdc:anaf.ro:efactura:cius-RO:1.0.1</cbc:CustomizationID>
  <cbc:ID>${xmlEscape(invoice.number)}</cbc:ID>
  <cbc:IssueDate>${dateIso(invoice.issueDate)}</cbc:IssueDate>
  <cbc:DueDate>${dateIso(invoice.dueDate)}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${xmlEscape(invoice.currency)}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="RO:CUI">${xmlEscape(supplierCui)}</cbc:EndpointID>
      <cac:PartyName>
        <cbc:Name>${xmlEscape(supplierName)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${xmlEscape(supplierAddress)}</cbc:StreetName>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cbc:EndpointID schemeID="RO:CUI">${xmlEscape(customerCui)}</cbc:EndpointID>
      <cac:PartyName>
        <cbc:Name>${xmlEscape(customerName)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${xmlEscape(customerAddress)}</cbc:StreetName>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${xmlEscape(invoice.currency)}">${taxAmount}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${xmlEscape(invoice.currency)}">${lineAmount}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${xmlEscape(invoice.currency)}">${taxAmount}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:Percent>${vatPercent.toFixed(2)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${xmlEscape(invoice.currency)}">${lineAmount}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${xmlEscape(invoice.currency)}">${lineAmount}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${xmlEscape(invoice.currency)}">${totalAmount}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${xmlEscape(invoice.currency)}">${totalAmount}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="H87">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${xmlEscape(invoice.currency)}">${lineAmount}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${xmlEscape(description)}</cbc:Name>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${xmlEscape(invoice.currency)}">${lineAmount}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
}

export async function uploadEfacturaXml(xml: string): Promise<{ uploadIndex: string; raw: unknown }> {
  if (env.ANAF_EFACTURA_MODE === 'mock') {
    return {
      uploadIndex: `mock-upload-${Date.now()}`,
      raw: { mode: 'mock', status: 'UPLOADED' },
    };
  }

  if (env.ANAF_EFACTURA_MODE !== 'live') {
    throw HttpError.conflict('Modul e-Factura nu este activat.');
  }

  const payload = await anafRequest('/upload', {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(),
      'content-type': 'application/xml; charset=utf-8',
      accept: 'application/json, text/plain, */*',
    },
    body: xml,
  });

  const uploadIndex = extractUploadIndex(payload);
  if (!uploadIndex) {
    throw new HttpError(502, 'ANAF e-Factura nu a returnat indexul de încărcare.', { expose: true });
  }

  return { uploadIndex, raw: payload };
}

export async function pollEfacturaStatus(uploadIndex: string): Promise<EFacturaStatusSnapshot> {
  if (env.ANAF_EFACTURA_MODE === 'mock') {
    return {
      status: 'ACCEPTED',
      uploadIndex,
      downloadId: `mock-download-${Date.now()}`,
      message: 'Factura acceptată (mock).',
      raw: { mode: 'mock', status: 'OK' },
    };
  }

  if (env.ANAF_EFACTURA_MODE !== 'live') {
    throw HttpError.conflict('Modul e-Factura nu este activat.');
  }

  const payload = await anafRequest(`/stareMesaj?id_incarcare=${encodeURIComponent(uploadIndex)}`, {
    method: 'GET',
    headers: {
      ...buildAuthHeaders(),
      accept: 'application/json, text/plain, */*',
    },
  });

  const { statusRaw, message } = extractStatusAndMessage(payload);
  const status = classifyStatus(payload, statusRaw, message);
  const downloadId = extractDownloadId(payload);

  return {
    status,
    uploadIndex,
    downloadId,
    message,
    raw: payload,
  };
}

export async function downloadSignedEfacturaXml(downloadId: string): Promise<{ xml: string; raw: unknown }> {
  if (env.ANAF_EFACTURA_MODE === 'mock') {
    const mockSignedXml = `<?xml version="1.0" encoding="UTF-8"?>\n<SignedInvoice id="${downloadId}" mode="mock" />\n`;
    return {
      xml: mockSignedXml,
      raw: { mode: 'mock', downloadId },
    };
  }

  if (env.ANAF_EFACTURA_MODE !== 'live') {
    throw HttpError.conflict('Modul e-Factura nu este activat.');
  }

  const payload = await anafRequest(`/descarcare?id=${encodeURIComponent(downloadId)}`, {
    method: 'GET',
    headers: {
      ...buildAuthHeaders(),
      accept: 'application/xml, text/xml, application/json, text/plain, */*',
    },
  });

  if (typeof payload === 'string') {
    return {
      xml: payload,
      raw: payload,
    };
  }

  const serialized = payloadText(payload);
  if (serialized.startsWith('<')) {
    return {
      xml: serialized,
      raw: payload,
    };
  }

  throw new HttpError(502, 'ANAF e-Factura nu a returnat XML-ul semnat.', { expose: true });
}

function sanitizeObjectPathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'unknown';
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function withObjectStorageRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(200 * attempt);
      }
    }
  }

  if (lastError instanceof HttpError) {
    throw lastError;
  }

  throw new HttpError(502, `Object storage indisponibil la ${operationName}.`, { expose: true });
}

export async function persistSignedEfacturaXml(companyId: string, invoiceId: string, xml: string): Promise<string> {
  const safeCompanyId = sanitizeObjectPathSegment(companyId);
  const safeInvoiceId = sanitizeObjectPathSegment(invoiceId);
  const fileName = `signed-${Date.now()}-${randomSuffix()}.xml`;
  const location = {
    bucket: env.MINIO_BUCKET_EFACTURA,
    key: `efactura/signed/${safeCompanyId}/${safeInvoiceId}/${fileName}`,
  };

  await withObjectStorageRetry(
    () => putObjectText(location, xml, 'application/xml; charset=utf-8'),
    'persistență XML semnat e-Factura',
  );

  return buildS3Uri(location);
}

function isLegacyFilesystemPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export async function loadSignedEfacturaXml(pathOrUri: string): Promise<string> {
  const s3Location = parseS3Uri(pathOrUri);
  if (s3Location) {
    return withObjectStorageRetry(() => getObjectText(s3Location), 'descărcare XML semnat e-Factura');
  }

  if (isLegacyFilesystemPath(pathOrUri)) {
    const safeBase = resolve(env.ANAF_EFACTURA_STORAGE_DIR);
    const safeTarget = resolve(pathOrUri);
    if (!safeTarget.startsWith(safeBase)) {
      throw HttpError.forbidden('Calea XML semnat este invalidă.');
    }

    return readFile(safeTarget, 'utf8');
  }

  throw HttpError.badRequest('Locatorul XML semnat e-Factura este invalid.');
}

export async function submitEfacturaEndToEnd(params: {
  xml: string;
  waitForSignedXml: boolean;
}): Promise<EFacturaSubmissionResult> {
  const upload = await uploadEfacturaXml(params.xml);
  let latest: EFacturaStatusSnapshot = {
    status: 'PENDING',
    uploadIndex: upload.uploadIndex,
    downloadId: null,
    message: null,
    raw: upload.raw,
  };

  if (env.ANAF_EFACTURA_MODE === 'mock') {
    const snapshot = await pollEfacturaStatus(upload.uploadIndex);
    let signedXml: string | null = null;
    if (params.waitForSignedXml && snapshot.downloadId) {
      const downloaded = await downloadSignedEfacturaXml(snapshot.downloadId);
      signedXml = downloaded.xml;
      latest = { ...snapshot, raw: downloaded.raw };
    } else {
      latest = snapshot;
    }

    return {
      ...latest,
      signedXml,
      polls: 1,
    };
  }

  const maxPolls = env.ANAF_EFACTURA_MAX_POLLS;
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    if (poll > 1) {
      await sleep(env.ANAF_EFACTURA_POLL_INTERVAL_MS);
    }

    latest = await pollEfacturaStatus(upload.uploadIndex);

    if (latest.status === 'REJECTED') {
      return {
        ...latest,
        signedXml: null,
        polls: poll,
      };
    }

    if (latest.status === 'ACCEPTED') {
      if (!params.waitForSignedXml || !latest.downloadId) {
        return {
          ...latest,
          signedXml: null,
          polls: poll,
        };
      }

      const downloaded = await downloadSignedEfacturaXml(latest.downloadId);
      return {
        ...latest,
        raw: downloaded.raw,
        signedXml: downloaded.xml,
        polls: poll,
      };
    }
  }

  return {
    ...latest,
    signedXml: null,
    polls: maxPolls,
  };
}
