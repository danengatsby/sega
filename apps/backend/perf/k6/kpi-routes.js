import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

function envOr(name, fallback) {
  const raw = __ENV[name];
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return fallback;
}

const baseUrl = envOr('PERF_BASE_URL', 'http://127.0.0.1:4000').replace(/\/+$/, '');
const email = envOr('PERF_USER_EMAIL', 'perf.accountant@sega.local');
const password = envOr('PERF_USER_PASSWORD', '');
const vus = Number(envOr('PERF_VUS', '8'));
const warmupDuration = envOr('PERF_WARMUP', '15s');
const steadyDuration = envOr('PERF_DURATION', '45s');
const sleepSeconds = Number(envOr('PERF_SLEEP_SECONDS', '0.2'));

const targetP95Ms = Number(envOr('PERF_TARGET_P95_MS', '300'));
const targetP99Ms = Number(envOr('PERF_TARGET_P99_MS', '700'));
const dashboardP95Ms = Number(envOr('PERF_DASHBOARD_P95_MS', '1000'));
const dashboardP99Ms = Number(envOr('PERF_DASHBOARD_P99_MS', '2000'));

if (!password) {
  throw new Error('Missing PERF_USER_PASSWORD environment variable.');
}

const authLoginLatency = new Trend('auth_login_latency', true);
const invoicesLatency = new Trend('invoices_latency', true);
const accountsLatency = new Trend('accounts_latency', true);
const dashboardLatency = new Trend('dashboard_latency', true);
const unauthorizedRate = new Rate('unauthorized_rate');

export const options = {
  scenarios: {
    steady_read_load: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: warmupDuration, target: vus },
        { duration: steadyDuration, target: vus },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    unauthorized_rate: ['rate==0'],
    invoices_latency: [`p(95)<${targetP95Ms}`, `p(99)<${targetP99Ms}`],
    accounts_latency: [`p(95)<${targetP95Ms}`, `p(99)<${targetP99Ms}`],
    dashboard_latency: [`p(95)<${dashboardP95Ms}`, `p(99)<${dashboardP99Ms}`],
    auth_login_latency: ['p(95)<800', 'p(99)<1500'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function parseJson(response) {
  try {
    return response.json();
  } catch (_error) {
    return null;
  }
}

function extractCookieToken(response, cookieName) {
  const cookieValues = response.cookies[cookieName];
  if (!cookieValues || cookieValues.length === 0) {
    return null;
  }
  const cookie = cookieValues[0];
  return cookie && typeof cookie.value === 'string' && cookie.value.length > 0 ? cookie.value : null;
}

function loginSession() {
  const response = http.post(
    `${baseUrl}/api/auth/login`,
    JSON.stringify({
      email,
      password,
    }),
    {
      headers: {
        'content-type': 'application/json',
      },
      tags: {
        route: 'auth_login',
      },
    },
  );

  authLoginLatency.add(response.timings.duration);

  const ok = check(response, {
    'login status is 200': (res) => res.status === 200,
  });

  if (!ok) {
    fail(`Autentificare eșuată pentru ${email}. Status=${response.status}.`);
  }

  const payload = parseJson(response);
  const companyId =
    payload && payload.user && typeof payload.user.companyId === 'string' ? payload.user.companyId : null;

  if (typeof companyId !== 'string' || companyId.length === 0) {
    fail('Login fără companyId în payload. Verifică fixture-ul de perf user.');
  }

  if (payload && payload.user && payload.user.mustChangePassword === true) {
    fail('User-ul de performanță are mustChangePassword=true. Rulează seed-ul de perf înainte de test.');
  }

  const accessToken = extractCookieToken(response, 'sega_access_token');
  if (!accessToken) {
    fail('Nu am putut extrage cookie-ul sega_access_token după login.');
  }

  return {
    accessToken,
    companyId,
  };
}

function authHeaders(session) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${session.accessToken}`,
    'x-company-id': session.companyId,
  };
}

function checkAuthStatus(response, routeName) {
  const unauthorized = response.status === 401 || response.status === 403;
  unauthorizedRate.add(unauthorized ? 1 : 0);

  check(response, {
    [`${routeName} status is 200`]: (res) => res.status === 200,
  });
}

export function setup() {
  return loginSession();
}

export default function runKpiRouteSuite(session) {
  const headers = authHeaders(session);

  const invoicesResponse = http.get(
    `${baseUrl}/api/invoices?paginate=true&page=1&pageSize=20&sort=issueDate:desc&search=PERF-INV-`,
    {
      headers,
      tags: {
        route: 'invoices_list',
      },
    },
  );
  invoicesLatency.add(invoicesResponse.timings.duration);
  checkAuthStatus(invoicesResponse, 'invoices');

  const accountsResponse = http.get(
    `${baseUrl}/api/accounts?paginate=true&page=1&pageSize=20&sort=code:asc&search=7`,
    {
      headers,
      tags: {
        route: 'accounts_search',
      },
    },
  );
  accountsLatency.add(accountsResponse.timings.duration);
  checkAuthStatus(accountsResponse, 'accounts');

  const dashboardResponse = http.get(
    `${baseUrl}/api/reports/dashboard-bi?dueSoonDays=7&overdueGraceDays=0&minAmount=100&maxAlerts=20`,
    {
      headers,
      tags: {
        route: 'dashboard_bi',
      },
    },
  );
  dashboardLatency.add(dashboardResponse.timings.duration);
  checkAuthStatus(dashboardResponse, 'dashboard');

  if (sleepSeconds > 0) {
    sleep(sleepSeconds);
  }
}
