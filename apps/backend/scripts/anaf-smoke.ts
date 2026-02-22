import 'dotenv/config';

const apiBase = (process.env.ANAF_SMOKE_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const email = process.env.ANAF_SMOKE_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@sega.local';
const password = process.env.ANAF_SMOKE_PASSWORD ?? process.env.ADMIN_PASSWORD ?? '';
const bootstrapToken = process.env.ANAF_SMOKE_BOOTSTRAP_TOKEN ?? process.env.BOOTSTRAP_ADMIN_TOKEN ?? '';
let activeCompanyId: string | null = null;
const cookieJar = new Map<string, string>();

function defaultPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

const period = process.env.ANAF_SMOKE_PERIOD ?? defaultPeriod();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function captureCookies(response: Response): void {
  for (const setCookie of response.headers.getSetCookie()) {
    const rawCookie = setCookie.split(';')[0];
    if (!rawCookie) {
      continue;
    }

    const equalsIndex = rawCookie.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const name = rawCookie.slice(0, equalsIndex).trim();
    const value = rawCookie.slice(equalsIndex + 1).trim();
    if (!name) {
      continue;
    }

    if (value.length === 0) {
      cookieJar.delete(name);
      continue;
    }

    cookieJar.set(name, value);
  }
}

function cookieHeader(): string | null {
  if (cookieJar.size === 0) {
    return null;
  }

  return Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function shouldSendCompanyHeader(path: string): boolean {
  return !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/bootstrap-admin');
}

function updateCompanyContext(payload: AuthPayload): void {
  const companyId = payload.user?.companyId;
  if (typeof companyId === 'string' && companyId.trim().length > 0) {
    activeCompanyId = companyId.trim();
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const cookieHeaderValue = cookieHeader();
  if (cookieHeaderValue) {
    headers.set('cookie', cookieHeaderValue);
  }
  if (activeCompanyId && shouldSendCompanyHeader(path)) {
    headers.set('x-company-id', activeCompanyId);
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
  });
  captureCookies(response);
  return response;
}

async function postJson(path: string, body: unknown, extraHeaders: HeadersInit = {}): Promise<Response> {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json');
  return request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Raspuns JSON invalid (${response.status}): ${text.slice(0, 400)}`);
  }
}

interface AuthPayload {
  user?: {
    mustChangePassword?: boolean;
    companyId?: string;
  };
}

async function loginOrBootstrap(): Promise<void> {
  assert(password.length > 0, 'Setează ANAF_SMOKE_PASSWORD sau ADMIN_PASSWORD înainte de rulare.');

  const fallbackNewPassword = process.env.ANAF_SMOKE_NEW_PASSWORD ?? `${password}#2026`;
  const loginCandidates = [password, fallbackNewPassword].filter((candidate, index, values) => {
    return candidate.length > 0 && values.indexOf(candidate) === index;
  });

  let currentPassword = loginCandidates[0] ?? password;
  let finalLoginResponse: Response | null = null;

  for (const loginCandidate of loginCandidates) {
    const candidateResponse = await postJson('/api/auth/login', {
      email,
      password: loginCandidate,
    });

    if (candidateResponse.ok) {
      currentPassword = loginCandidate;
      finalLoginResponse = candidateResponse;
      break;
    }

    finalLoginResponse = candidateResponse;
  }

  if (!finalLoginResponse?.ok) {
    const bootstrapHeaders: HeadersInit = {
      ...(bootstrapToken ? { 'x-bootstrap-token': bootstrapToken } : {}),
    };

    const bootstrapResponse = await postJson(
      '/api/auth/bootstrap-admin',
      {
        email,
        name: 'Admin',
        password: password,
      },
      bootstrapHeaders,
    );

    if (!bootstrapResponse.ok) {
      const bootstrapBody = await bootstrapResponse.text();
      throw new Error(`bootstrap-admin a esuat. HTTP ${bootstrapResponse.status}. Body: ${bootstrapBody.slice(0, 400)}`);
    }

    finalLoginResponse = await postJson('/api/auth/login', {
      email,
      password: password,
    });
    currentPassword = password;
  }

  assert(finalLoginResponse, 'Login esuat: raspuns lipsa.');
  assert(finalLoginResponse.ok, `Login esuat. HTTP ${finalLoginResponse.status}`);

  const loginData = await parseJson<AuthPayload>(finalLoginResponse);
  updateCompanyContext(loginData);

  if (!loginData.user?.mustChangePassword) {
    return;
  }

  let newPassword = process.env.ANAF_SMOKE_NEW_PASSWORD ?? `${currentPassword}#2026`;
  if (newPassword === currentPassword) {
    newPassword = `${currentPassword}!`;
  }
  assert(newPassword.length >= 12, 'ANAF_SMOKE_NEW_PASSWORD trebuie sa aiba minim 12 caractere.');

  const changePasswordResponse = await postJson('/api/auth/change-password', {
    currentPassword: currentPassword,
    newPassword,
  });

  if (!changePasswordResponse.ok) {
    const responseText = await changePasswordResponse.text();
    throw new Error(`change-password a esuat. HTTP ${changePasswordResponse.status}. Body: ${responseText.slice(0, 400)}`);
  }

  const changedPayload = await parseJson<AuthPayload>(changePasswordResponse);
  updateCompanyContext(changedPayload);
  currentPassword = newPassword;
  if (changedPayload.user?.mustChangePassword === true) {
    const reloginResponse = await postJson('/api/auth/login', {
      email,
      password: currentPassword,
    });
    assert(reloginResponse.ok, `Relogin dupa schimbare parola a esuat. HTTP ${reloginResponse.status}`);
    const reloginPayload = await parseJson<AuthPayload>(reloginResponse);
    updateCompanyContext(reloginPayload);
  }
}

async function checkDeclaration(declaration: 'd300' | 'd394' | 'd112' | 'd406'): Promise<void> {
  const response = await request(`/api/reports/export/anaf/${declaration}.xml?period=${period}&validate=true`);

  const body = await response.text();
  assert(response.ok, `${declaration.toUpperCase()} HTTP ${response.status}. Body: ${body.slice(0, 400)}`);

  const performed = response.headers.get('x-anaf-xsd-performed');
  const valid = response.headers.get('x-anaf-xsd-valid');

  assert(performed === 'true', `${declaration.toUpperCase()} nu a executat validarea XSD (x-anaf-xsd-performed=${performed}).`);
  assert(valid === 'true', `${declaration.toUpperCase()} nu este valid XSD (x-anaf-xsd-valid=${valid}).`);

  console.log(`[OK] ${declaration.toUpperCase()} XSD performed=${performed} valid=${valid}`);
}

interface ValidationResult {
  declaration: string;
  xsd: {
    performed: boolean;
    valid: boolean | null;
  };
}

interface ValidationPayload {
  period: string;
  results: ValidationResult[];
}

async function checkValidationSummary(): Promise<void> {
  const response = await request(`/api/reports/export/anaf/validation?period=${period}&validate=true`);
  assert(response.ok, `Endpoint validation summary a raspuns cu HTTP ${response.status}.`);

  const payload = await parseJson<ValidationPayload>(response);
  assert(payload.results.length >= 3, 'Validation summary nu contine toate declaratiile.');

  for (const result of payload.results) {
    assert(result.xsd.performed === true, `${result.declaration}: xsd.performed trebuie sa fie true.`);
    assert(result.xsd.valid === true, `${result.declaration}: xsd.valid trebuie sa fie true.`);
  }

  console.log('[OK] Validation summary: toate declaratiile au xsd.performed=true si xsd.valid=true');
}

async function main(): Promise<void> {
  console.log(`ANAF smoke start: ${apiBase}, period=${period}`);
  await loginOrBootstrap();

  await checkDeclaration('d300');
  await checkDeclaration('d394');
  await checkDeclaration('d112');
  await checkDeclaration('d406');
  await checkValidationSummary();

  console.log('ANAF smoke PASSED');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ANAF smoke FAILED: ${message}`);
  process.exit(1);
});
