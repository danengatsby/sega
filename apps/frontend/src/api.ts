export const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  skipAuthRefresh?: boolean;
  companyId?: string | null;
}

const AUTH_PATHS_WITHOUT_REFRESH = new Set(['/auth/login', '/auth/refresh', '/auth/bootstrap-admin', '/auth/logout']);
const AUTH_PATHS_WITHOUT_COMPANY_CONTEXT = new Set(['/auth/login', '/auth/bootstrap-admin']);
let refreshInFlight: Promise<boolean> | null = null;
let activeCompanyId: string | null = null;

function normalizeCompanyId(companyId: string | null | undefined): string | null {
  if (!companyId) {
    return null;
  }

  const trimmed = companyId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function setApiCompanyContext(companyId: string | null | undefined): void {
  activeCompanyId = normalizeCompanyId(companyId);
}

function requestBasePath(path: string): string {
  return path.split('?')[0] ?? path;
}

async function tryRefreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await executeRequest('/auth/refresh', {
          method: 'POST',
          skipAuthRefresh: true,
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }

  return refreshInFlight;
}

async function parseJsonPayload(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function resolveRequestCompanyId(path: string, options: RequestOptions): string | null {
  if (Object.prototype.hasOwnProperty.call(options, 'companyId')) {
    return normalizeCompanyId(options.companyId ?? null);
  }

  const basePath = requestBasePath(path);
  if (AUTH_PATHS_WITHOUT_COMPANY_CONTEXT.has(basePath)) {
    return null;
  }

  return activeCompanyId;
}

async function executeRequest(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const companyId = resolveRequestCompanyId(path, options);
  if (companyId) {
    headers['x-company-id'] = companyId;
  }

  return fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    body: typeof options.body === 'undefined' ? undefined : JSON.stringify(options.body),
  });
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const basePath = requestBasePath(path);
  let response = await executeRequest(path, options);

  if (
    response.status === 401 &&
    !options.skipAuthRefresh &&
    !AUTH_PATHS_WITHOUT_REFRESH.has(basePath)
  ) {
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      response = await executeRequest(path, {
        ...options,
        skipAuthRefresh: true,
      });
    }
  }

  const payload = await parseJsonPayload(response);

  if (!response.ok) {
    const maybePayload = payload as { message?: unknown; code?: unknown };
    const message =
      typeof maybePayload.message === 'string' ? maybePayload.message : `Request failed with status ${response.status}`;
    const code = typeof maybePayload.code === 'string' ? maybePayload.code : undefined;
    throw new ApiError(message, response.status, code);
  }

  return payload as T;
}
