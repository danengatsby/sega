import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildServiceOpenApiDocument,
  listServiceContractNames,
  SERVICE_CONTRACT_DEFINITIONS,
  type ServiceContractName,
} from './service-contracts.js';

function isPathAllowed(serviceName: ServiceContractName, pathname: string): boolean {
  const prefixes = SERVICE_CONTRACT_DEFINITIONS[serviceName].pathPrefixes;
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

test('service contracts return at least one endpoint for each extracted service', () => {
  for (const serviceName of listServiceContractNames()) {
    const document = buildServiceOpenApiDocument(serviceName);
    assert.ok(Object.keys(document.paths).length > 0, `Contractul ${serviceName} nu are endpoint-uri.`);
  }
});

test('auth-service contract conține doar endpoint-uri auth/health/metrics', () => {
  const document = buildServiceOpenApiDocument('auth-service');
  for (const pathname of Object.keys(document.paths)) {
    assert.ok(isPathAllowed('auth-service', pathname), `Path neașteptat în auth-service: ${pathname}`);
  }

  const authPaths = Object.keys(document.paths);
  assert.ok(authPaths.includes('/api/auth/login'), 'Lipsește endpoint-ul critic POST /api/auth/login.');
  assert.ok(authPaths.includes('/api/auth/me'), 'Lipsește endpoint-ul critic GET /api/auth/me.');
});

test('invoice-service contract conține doar endpoint-uri invoice/health/metrics', () => {
  const document = buildServiceOpenApiDocument('invoice-service');
  for (const pathname of Object.keys(document.paths)) {
    assert.ok(isPathAllowed('invoice-service', pathname), `Path neașteptat în invoice-service: ${pathname}`);
  }

  const invoicePaths = Object.keys(document.paths);
  assert.ok(invoicePaths.includes('/api/invoices'), 'Lipsește endpoint-ul critic GET/POST /api/invoices.');
  assert.ok(invoicePaths.includes('/api/invoices/{id}/pay'), 'Lipsește endpoint-ul critic POST /api/invoices/{id}/pay.');
});
