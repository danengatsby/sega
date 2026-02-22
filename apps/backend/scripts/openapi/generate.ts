import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument, evaluateCriticalCoverage } from '../../src/openapi/spec.js';

function outputPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const backendRoot = path.resolve(currentDir, '../..');
  return path.join(backendRoot, 'openapi', 'openapi.json');
}

function failOnCoverageGaps(): void {
  const coverage = evaluateCriticalCoverage();
  if (coverage.missingInImplementation.length > 0) {
    console.error('[openapi] Endpoint-uri critice lipsă din implementare:');
    for (const key of coverage.missingInImplementation) {
      console.error(`  - ${key}`);
    }
    process.exit(1);
  }

  if (coverage.missingInSpec.length > 0) {
    console.error('[openapi] Endpoint-uri critice lipsă din specificația OpenAPI:');
    for (const key of coverage.missingInSpec) {
      console.error(`  - ${key}`);
    }
    process.exit(1);
  }

  console.log(`[openapi] Critical coverage: ${coverage.documentedCritical}/${coverage.totalCritical}`);
}

function main(): void {
  const document = buildOpenApiDocument();
  const target = outputPath();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`[openapi] Spec generated: ${target}`);
  failOnCoverageGaps();
}

main();
