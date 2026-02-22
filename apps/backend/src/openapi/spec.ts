import { CRITICAL_ENDPOINTS } from './critical-endpoints.js';
import { discoverRouteEndpoints } from './discover-endpoints.js';
import { endpointKey, type EndpointDescriptor, type HttpMethod } from './types.js';

const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

interface OpenApiResponse {
  description: string;
}

interface OpenApiSchema {
  type: string;
  additionalProperties?: boolean;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
}

interface OpenApiMediaType {
  schema: OpenApiSchema;
}

interface OpenApiRequestBody {
  required: boolean;
  content: Record<string, OpenApiMediaType>;
}

interface OpenApiOperation {
  tags: string[];
  summary: string;
  operationId: string;
  description: string;
  security?: Array<Record<string, string[]>>;
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
  'x-source': string;
  'x-critical': boolean;
}

type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>>;

export interface OpenApiDocument {
  openapi: '3.0.3';
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers: Array<{
    url: string;
    description: string;
  }>;
  tags: Array<{
    name: string;
    description: string;
  }>;
  paths: Record<string, OpenApiPathItem>;
  components: {
    securitySchemes: Record<string, Record<string, string>>;
    schemas: Record<string, OpenApiSchema>;
  };
}

export interface CriticalCoverageReport {
  totalCritical: number;
  documentedCritical: number;
  implementedCritical: number;
  missingInImplementation: string[];
  missingInSpec: string[];
}

let cachedOpenApiDocument: OpenApiDocument | null = null;

function criticalEndpointKeys(): Set<string> {
  return new Set(CRITICAL_ENDPOINTS.map((entry) => endpointKey(entry.method, entry.path)));
}

function requestBodyForMethod(method: HttpMethod): OpenApiRequestBody | undefined {
  if (!['post', 'put', 'patch'].includes(method)) {
    return undefined;
  }

  return {
    required: false,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  };
}

function buildResponses(method: HttpMethod, security: EndpointDescriptor['security']): Record<string, OpenApiResponse> {
  const successCode = method === 'post' ? '201' : '200';
  const responses: Record<string, OpenApiResponse> = {
    [successCode]: {
      description: 'Operație procesată cu succes.',
    },
    '400': {
      description: 'Cererea este invalidă.',
    },
    '404': {
      description: 'Resursa solicitată nu există.',
    },
    '409': {
      description: 'Conflict de stare pentru resursa solicitată.',
    },
    '429': {
      description: 'Limită de rată depășită.',
    },
    '500': {
      description: 'Eroare internă.',
    },
  };

  if (security !== 'public') {
    responses['401'] = {
      description: 'Autentificare necesară sau token invalid.',
    };
    responses['403'] = {
      description: 'Permisiuni insuficiente pentru această operațiune.',
    };
  }

  return responses;
}

function securityForEndpoint(security: EndpointDescriptor['security']): Array<Record<string, string[]>> | undefined {
  if (security === 'public') {
    return [];
  }
  return [{ cookieAuth: [] }, { bearerAuth: [] }];
}

function endpointToOperation(endpoint: EndpointDescriptor, criticalKeys: Set<string>): OpenApiOperation {
  const key = endpointKey(endpoint.method, endpoint.path);
  const requestBody = requestBodyForMethod(endpoint.method);
  const operation: OpenApiOperation = {
    tags: [endpoint.tag],
    summary: endpoint.summary,
    operationId: endpoint.operationId,
    description: `Contract OpenAPI auto-generat pentru ${endpoint.method.toUpperCase()} ${endpoint.path}.`,
    security: securityForEndpoint(endpoint.security),
    responses: buildResponses(endpoint.method, endpoint.security),
    'x-source': endpoint.source,
    'x-critical': criticalKeys.has(key),
  };

  if (requestBody) {
    operation.requestBody = requestBody;
  }

  return operation;
}

export function extractOpenApiEndpointKeys(document: OpenApiDocument): Set<string> {
  const keys = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      if (pathItem[method]) {
        keys.add(endpointKey(method, path));
      }
    }
  }
  return keys;
}

export function evaluateCriticalCoverage(document: OpenApiDocument = buildOpenApiDocument()): CriticalCoverageReport {
  const criticalKeys = [...criticalEndpointKeys()];
  const discoveredKeys = new Set(discoverRouteEndpoints().map((entry) => endpointKey(entry.method, entry.path)));
  const documentedKeys = extractOpenApiEndpointKeys(document);

  const missingInImplementation = criticalKeys.filter((key) => !discoveredKeys.has(key));
  const missingInSpec = criticalKeys.filter((key) => !documentedKeys.has(key));

  return {
    totalCritical: criticalKeys.length,
    implementedCritical: criticalKeys.length - missingInImplementation.length,
    documentedCritical: criticalKeys.length - missingInSpec.length,
    missingInImplementation,
    missingInSpec,
  };
}

export function buildOpenApiDocument(): OpenApiDocument {
  const endpoints = discoverRouteEndpoints();
  const criticalKeys = criticalEndpointKeys();
  const paths: Record<string, OpenApiPathItem> = {};
  const tags = new Map<string, string>();

  for (const endpoint of endpoints) {
    if (!paths[endpoint.path]) {
      paths[endpoint.path] = {};
    }
    paths[endpoint.path]![endpoint.method] = endpointToOperation(endpoint, criticalKeys);
    if (!tags.has(endpoint.tag)) {
      tags.set(endpoint.tag, `Endpoint-uri ${endpoint.tag}.`);
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'SEGA Accounting API',
      description:
        'Specificație OpenAPI 3.0 generată automat din routerele backend. Include endpoint-urile critice pentru audit de conformitate API-First.',
      version: '3.0.0',
    },
    servers: [
      {
        url: '/',
        description: 'Server relativ (local/staging/prod prin host-ul curent)',
      },
    ],
    tags: [...tags.entries()]
      .map(([name, description]) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    paths,
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sega_access_token',
          description: 'Access token JWT transportat în cookie HttpOnly.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Alternativ, access token JWT transmis în Authorization: Bearer.',
        },
      },
      schemas: {
        GenericObject: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  };
}

export function getOpenApiDocument(): OpenApiDocument {
  if (!cachedOpenApiDocument) {
    cachedOpenApiDocument = buildOpenApiDocument();
  }
  return cachedOpenApiDocument;
}

export function clearOpenApiDocumentCache(): void {
  cachedOpenApiDocument = null;
}
