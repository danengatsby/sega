import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointKey, type EndpointDescriptor, type HttpMethod } from './types.js';

const SUPPORTED_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const ROUTE_IMPORT_PATTERN = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]\.\/routes\/([^'"]+)\.js['"];/g;
const ROUTE_MOUNT_PATTERN = /app\.use\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
const ROUTE_HANDLER_PATTERN = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;

const PUBLIC_ENDPOINT_KEYS = new Set<string>([
  'GET /metrics',
  'GET /api/health',
  'GET /api/openapi.json',
  'GET /api/docs',
  'POST /api/auth/login',
  'POST /api/auth/refresh',
  'POST /api/auth/bootstrap-admin',
  'POST /api/auth/logout',
]);

const STATIC_ENDPOINTS: Array<{
  method: HttpMethod;
  path: string;
  tag: string;
  source: string;
}> = [
  { method: 'get', path: '/metrics', tag: 'Health', source: 'app' },
  { method: 'get', path: '/api/health', tag: 'Health', source: 'app' },
  { method: 'get', path: '/api/openapi.json', tag: 'Docs', source: 'app' },
  { method: 'get', path: '/api/docs', tag: 'Docs', source: 'app' },
];

interface MountedRouter {
  variableName: string;
  routeFile: string;
  basePath: string;
}

function runtimeSourceRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '..');
}

function resolveExistingModulePath(withoutExtension: string): string {
  const candidates = [`${withoutExtension}.ts`, `${withoutExtension}.js`];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Nu pot găsi fișierul ${withoutExtension}.{ts|js}`);
}

function readAppSource(sourceRoot: string): string {
  const appFile = resolveExistingModulePath(path.join(sourceRoot, 'app'));
  return readFileSync(appFile, 'utf8');
}

function parseRouteImports(appSource: string): Map<string, string> {
  const imports = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = ROUTE_IMPORT_PATTERN.exec(appSource)) !== null) {
    const variableName = match[1];
    const routeFile = match[2];
    if (!variableName || !routeFile) {
      continue;
    }
    imports.set(variableName, routeFile);
  }
  return imports;
}

function parseMountedRouters(appSource: string, routeImports: Map<string, string>): MountedRouter[] {
  const mountedRouters: MountedRouter[] = [];
  let match: RegExpExecArray | null;
  while ((match = ROUTE_MOUNT_PATTERN.exec(appSource)) !== null) {
    const basePath = match[1];
    const variableName = match[2];
    if (!basePath || !variableName) {
      continue;
    }
    const routeFile = routeImports.get(variableName);
    if (!routeFile) {
      continue;
    }
    mountedRouters.push({
      variableName,
      routeFile,
      basePath: normalizePath(basePath),
    });
  }
  return mountedRouters;
}

function parseRouteHandlers(routeSource: string): Array<{ method: HttpMethod; routePath: string }> {
  const handlers: Array<{ method: HttpMethod; routePath: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = ROUTE_HANDLER_PATTERN.exec(routeSource)) !== null) {
    const rawMethod = match[1] as HttpMethod | undefined;
    const routePath = match[2];
    if (!rawMethod || !routePath || !SUPPORTED_METHODS.includes(rawMethod)) {
      continue;
    }
    handlers.push({
      method: rawMethod,
      routePath,
    });
  }
  return handlers;
}

function normalizePath(value: string): string {
  let normalized = value.trim();
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function combinePath(basePath: string, routePath: string): string {
  if (!routePath || routePath === '/') {
    return normalizePath(basePath);
  }

  return normalizePath(`${normalizePath(basePath)}/${routePath.replace(/^\/+/, '')}`);
}

function toOpenApiPath(pathValue: string): string {
  return pathValue.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function capitalize(word: string): string {
  if (word.length === 0) {
    return word;
  }
  return word[0]!.toUpperCase() + word.slice(1);
}

function formatTag(routeFile: string): string {
  return routeFile
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => capitalize(part))
    .join(' ');
}

function buildOperationId(method: HttpMethod, fullPath: string): string {
  const raw = `${method}-${fullPath}`.replace(/[{}]/g, '');
  const parts = raw
    .split(/[^a-zA-Z0-9]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());

  if (parts.length === 0) {
    return `${method}Root`;
  }

  return parts
    .map((part, index) => (index === 0 ? part : capitalize(part)))
    .join('');
}

function buildSummary(method: HttpMethod, fullPath: string, tag: string): string {
  const actionByMethod: Record<HttpMethod, string> = {
    get: 'Read',
    post: 'Create/Execute',
    put: 'Replace',
    patch: 'Update',
    delete: 'Delete',
  };

  const resource = fullPath
    .replace(/^\/api\//, '')
    .split('/')
    .filter((segment) => segment.length > 0 && !segment.startsWith('{'))
    .join(' ');

  return `${actionByMethod[method]} ${resource || tag}`.trim();
}

function endpointSecurity(method: HttpMethod, fullPath: string): 'public' | 'protected' {
  const key = endpointKey(method, fullPath);
  return PUBLIC_ENDPOINT_KEYS.has(key) ? 'public' : 'protected';
}

function routeSourcePath(sourceRoot: string, routeFile: string): string {
  return resolveExistingModulePath(path.join(sourceRoot, 'routes', routeFile));
}

function sortEndpoints(a: EndpointDescriptor, b: EndpointDescriptor): number {
  if (a.path !== b.path) {
    return a.path.localeCompare(b.path);
  }
  return a.method.localeCompare(b.method);
}

export function discoverRouteEndpoints(): EndpointDescriptor[] {
  const sourceRoot = runtimeSourceRoot();
  const appSource = readAppSource(sourceRoot);
  const routeImports = parseRouteImports(appSource);
  const mountedRouters = parseMountedRouters(appSource, routeImports);

  const discovered = new Map<string, EndpointDescriptor>();

  for (const mountedRouter of mountedRouters) {
    const routeSource = readFileSync(routeSourcePath(sourceRoot, mountedRouter.routeFile), 'utf8');
    const routeHandlers = parseRouteHandlers(routeSource);
    const tag = formatTag(mountedRouter.routeFile);

    for (const routeHandler of routeHandlers) {
      const fullPath = toOpenApiPath(combinePath(mountedRouter.basePath, routeHandler.routePath));
      const key = endpointKey(routeHandler.method, fullPath);
      if (discovered.has(key)) {
        continue;
      }
      discovered.set(key, {
        method: routeHandler.method,
        path: fullPath,
        tag,
        source: `routes/${mountedRouter.routeFile}`,
        summary: buildSummary(routeHandler.method, fullPath, tag),
        operationId: buildOperationId(routeHandler.method, fullPath),
        security: endpointSecurity(routeHandler.method, fullPath),
      });
    }
  }

  for (const staticEndpoint of STATIC_ENDPOINTS) {
    const normalizedPath = toOpenApiPath(normalizePath(staticEndpoint.path));
    const key = endpointKey(staticEndpoint.method, normalizedPath);
    if (discovered.has(key)) {
      continue;
    }

    discovered.set(key, {
      method: staticEndpoint.method,
      path: normalizedPath,
      tag: staticEndpoint.tag,
      source: staticEndpoint.source,
      summary: buildSummary(staticEndpoint.method, normalizedPath, staticEndpoint.tag),
      operationId: buildOperationId(staticEndpoint.method, normalizedPath),
      security: endpointSecurity(staticEndpoint.method, normalizedPath),
    });
  }

  return [...discovered.values()].sort(sortEndpoints);
}
