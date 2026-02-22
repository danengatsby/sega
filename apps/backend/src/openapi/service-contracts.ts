import { buildOpenApiDocument, type OpenApiDocument } from './spec.js';

interface ServiceContractDefinition {
  title: string;
  description: string;
  pathPrefixes: string[];
}

export const SERVICE_CONTRACT_DEFINITIONS = {
  'auth-service': {
    title: 'SEGA Auth Service API',
    description: 'Contract OpenAPI pentru serviciul extras de autentificare/autorizare.',
    pathPrefixes: ['/api/auth', '/api/health', '/metrics'],
  },
  'invoice-service': {
    title: 'SEGA Invoice Service API',
    description: 'Contract OpenAPI pentru serviciul extras de facturare și încasări clienți.',
    pathPrefixes: ['/api/invoices', '/api/health', '/metrics'],
  },
} as const satisfies Record<string, ServiceContractDefinition>;

export type ServiceContractName = keyof typeof SERVICE_CONTRACT_DEFINITIONS;

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) {
    return true;
  }

  if (prefix.endsWith('/')) {
    return pathname.startsWith(prefix);
  }

  return pathname.startsWith(`${prefix}/`);
}

function isPathIncluded(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => matchesPathPrefix(pathname, prefix));
}

function usedTags(document: OpenApiDocument): Set<string> {
  const tags = new Set<string>();
  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem)) {
      if (!operation) {
        continue;
      }
      for (const tag of operation.tags) {
        tags.add(tag);
      }
    }
  }
  return tags;
}

export function buildServiceOpenApiDocument(
  serviceName: ServiceContractName,
  document: OpenApiDocument = buildOpenApiDocument(),
): OpenApiDocument {
  const definition = SERVICE_CONTRACT_DEFINITIONS[serviceName];
  const filteredPaths = Object.fromEntries(
    Object.entries(document.paths).filter(([pathname]) => isPathIncluded(pathname, definition.pathPrefixes)),
  );

  const filteredDocument: OpenApiDocument = {
    ...document,
    info: {
      ...document.info,
      title: definition.title,
      description: definition.description,
    },
    paths: filteredPaths,
  };

  const tags = usedTags(filteredDocument);
  filteredDocument.tags = document.tags.filter((tag) => tags.has(tag.name));

  return filteredDocument;
}

export function listServiceContractNames(): ServiceContractName[] {
  return Object.keys(SERVICE_CONTRACT_DEFINITIONS) as ServiceContractName[];
}
