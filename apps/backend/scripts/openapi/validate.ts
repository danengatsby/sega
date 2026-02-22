import SwaggerParser from '@apidevtools/swagger-parser';
import { buildOpenApiDocument, evaluateCriticalCoverage } from '../../src/openapi/spec.js';

async function main(): Promise<void> {
  const document = buildOpenApiDocument();
  await SwaggerParser.validate(document);

  const coverage = evaluateCriticalCoverage(document);

  if (coverage.totalCritical === 0) {
    throw new Error('[openapi] Lista endpoint-urilor critice este goală.');
  }

  if (coverage.missingInImplementation.length > 0) {
    throw new Error(
      `[openapi] Endpoint-uri critice neimplementate (${coverage.missingInImplementation.length}): ${coverage.missingInImplementation.join(', ')}`,
    );
  }

  if (coverage.missingInSpec.length > 0) {
    throw new Error(
      `[openapi] Endpoint-uri critice nedocumentate (${coverage.missingInSpec.length}): ${coverage.missingInSpec.join(', ')}`,
    );
  }

  if (coverage.documentedCritical !== coverage.totalCritical) {
    throw new Error(
      `[openapi] Acoperire critică incompletă: ${coverage.documentedCritical}/${coverage.totalCritical}`,
    );
  }

  console.log('[openapi] OpenAPI 3.0 contract valid.');
  console.log(`[openapi] Critical endpoint coverage: ${coverage.documentedCritical}/${coverage.totalCritical} (100%).`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
