import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExportJobSchema, toCreatePayload } from './export-jobs-service.js';

test('toCreatePayload forțează validate=true pentru exporturile ANAF în strict mode', () => {
  const input = createExportJobSchema.parse({
    kind: 'ANAF_D300',
    period: '2026-01',
    strict: true,
    validate: false,
  });
  const payload = toCreatePayload(input);

  assert.equal(payload.strict, true);
  assert.equal(payload.validate, true);
});

test('toCreatePayload păstrează validate explicit când strict=false', () => {
  const input = createExportJobSchema.parse({
    kind: 'ANAF_D300',
    period: '2026-01',
    strict: false,
    validate: false,
  });
  const payload = toCreatePayload(input);

  assert.equal(payload.strict, false);
  assert.equal(payload.validate, false);
});

