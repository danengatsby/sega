import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServiceOpenApiDocument, listServiceContractNames } from '../../src/openapi/service-contracts.js';

function outputPath(serviceName: string): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const backendRoot = path.resolve(currentDir, '../..');
  return path.join(backendRoot, 'openapi', `${serviceName}.openapi.json`);
}

function main(): void {
  for (const serviceName of listServiceContractNames()) {
    const document = buildServiceOpenApiDocument(serviceName);
    const target = outputPath(serviceName);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    console.log(`[openapi] Service contract generated: ${target}`);
  }
}

main();
