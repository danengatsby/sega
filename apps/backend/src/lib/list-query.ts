import type { Response } from 'express';
import { HttpError } from './http-error.js';

export type SortDirection = 'asc' | 'desc';

export interface ParseListQueryOptions<SortField extends string> {
  allowedSortFields: readonly SortField[];
  defaultSortField: SortField;
  defaultSortDirection?: SortDirection;
  defaultPageSize?: number;
  maxPageSize?: number;
  defaultPaginationEnabled?: boolean;
}

export interface ListQuery<SortField extends string> {
  page: number;
  pageSize: number;
  search: string | null;
  sortField: SortField;
  sortDirection: SortDirection;
  paginationEnabled: boolean;
  skip: number | undefined;
  take: number | undefined;
}

function readQueryString(query: Record<string, unknown>, key: string): string | undefined {
  const raw = query[key];
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw === 'string') {
    return raw;
  }

  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
    return raw[0];
  }

  throw HttpError.badRequest(`Parametrul "${key}" este invalid.`);
}

function parsePositiveInt(raw: string, field: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw HttpError.badRequest(`Parametrul "${field}" trebuie să fie un număr întreg pozitiv.`);
  }
  return value;
}

function parseBoolean(raw: string, field: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n'].includes(normalized)) {
    return false;
  }
  throw HttpError.badRequest(`Parametrul "${field}" trebuie să fie boolean (true/false).`);
}

function parseSort<SortField extends string>(
  rawSort: string | undefined,
  options: ParseListQueryOptions<SortField>,
): { sortField: SortField; sortDirection: SortDirection } {
  const defaultDirection = options.defaultSortDirection ?? 'asc';
  if (!rawSort) {
    return { sortField: options.defaultSortField, sortDirection: defaultDirection };
  }

  const [rawField, rawDirection] = rawSort.split(':');
  const field = rawField?.trim() as SortField | undefined;
  const direction = rawDirection?.trim().toLowerCase();

  if (!field || !options.allowedSortFields.includes(field)) {
    throw HttpError.badRequest(
      `Parametrul "sort" este invalid. Câmpuri permise: ${options.allowedSortFields.join(', ')}.`,
    );
  }

  if (direction && direction !== 'asc' && direction !== 'desc') {
    throw HttpError.badRequest('Direcția de sortare trebuie să fie "asc" sau "desc".');
  }

  return {
    sortField: field,
    sortDirection: (direction ?? defaultDirection) as SortDirection,
  };
}

export function parseListQuery<SortField extends string>(
  query: Record<string, unknown>,
  options: ParseListQueryOptions<SortField>,
): ListQuery<SortField> {
  const maxPageSize = options.maxPageSize ?? 200;
  const defaultPageSize = options.defaultPageSize ?? 50;

  const rawPage = readQueryString(query, 'page');
  const rawPageSize = readQueryString(query, 'pageSize');
  const rawAll = readQueryString(query, 'all');
  const rawPaginate = readQueryString(query, 'paginate');
  const rawSearch = readQueryString(query, 'search');
  const rawSort = readQueryString(query, 'sort');

  const page = rawPage ? parsePositiveInt(rawPage, 'page') : 1;
  const pageSizeUncapped = rawPageSize ? parsePositiveInt(rawPageSize, 'pageSize') : defaultPageSize;
  const pageSize = Math.min(pageSizeUncapped, maxPageSize);
  if (rawAll !== undefined && rawPaginate !== undefined) {
    throw HttpError.badRequest('Parametrii "all" și "paginate" nu pot fi folosiți împreună.');
  }

  const allRequested = rawAll ? parseBoolean(rawAll, 'all') : false;
  const paginationEnabled = allRequested
    ? false
    : (rawPaginate ? parseBoolean(rawPaginate, 'paginate') : (options.defaultPaginationEnabled ?? true));

  if (!paginationEnabled && (rawPage !== undefined || rawPageSize !== undefined)) {
    throw HttpError.badRequest('Parametrii "page" și "pageSize" nu pot fi folosiți când "paginate=false".');
  }

  const normalizedSearch = rawSearch?.trim() ?? '';
  const search = normalizedSearch.length > 0 ? normalizedSearch.slice(0, 120) : null;
  const { sortField, sortDirection } = parseSort(rawSort, options);

  return {
    page,
    pageSize,
    search,
    sortField,
    sortDirection,
    paginationEnabled,
    skip: paginationEnabled ? (page - 1) * pageSize : undefined,
    take: paginationEnabled ? pageSize : undefined,
  };
}

export function setPaginationHeaders(
  res: Response,
  payload: { totalCount: number; page: number; pageSize: number },
): void {
  const totalPages = payload.totalCount === 0 ? 0 : Math.ceil(payload.totalCount / payload.pageSize);

  res.setHeader('X-Total-Count', String(payload.totalCount));
  res.setHeader('X-Page', String(payload.page));
  res.setHeader('X-Page-Size', String(payload.pageSize));
  res.setHeader('X-Total-Pages', String(totalPages));
}
