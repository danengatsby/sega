import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenApiDocument, evaluateCriticalCoverage } from './spec.js';

test('openapi spec covers all critical endpoints', () => {
  const document = buildOpenApiDocument();
  const coverage = evaluateCriticalCoverage(document);

  assert.equal(document.openapi, '3.0.3');
  assert.ok(Object.keys(document.paths).length > 0);
  assert.equal(coverage.missingInImplementation.length, 0);
  assert.equal(coverage.missingInSpec.length, 0);
  assert.equal(coverage.documentedCritical, coverage.totalCritical);
});
