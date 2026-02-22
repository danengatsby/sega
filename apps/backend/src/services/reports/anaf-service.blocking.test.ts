import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnafValidationSummary } from './types.js';
import { hasAnafBlockingErrors } from './anaf-service.js';

function buildValidation(
  overrides?: Partial<AnafValidationSummary>,
  xsdOverrides?: Partial<AnafValidationSummary['xsd']>,
): AnafValidationSummary {
  const base: AnafValidationSummary = {
    declaration: 'D300',
    period: '2026-01',
    profile: {
      valid: true,
      errors: [],
      warnings: [],
    },
    xsd: {
      performed: true,
      valid: true,
      validator: 'xmllint',
      schemaPath: '/tmp/d300.xsd',
      errors: [],
      warnings: [],
    },
  };

  if (overrides?.declaration) {
    base.declaration = overrides.declaration;
  }
  if (overrides?.period) {
    base.period = overrides.period;
  }
  if (overrides?.profile) {
    base.profile = { ...base.profile, ...overrides.profile };
  }
  if (overrides?.xsd) {
    base.xsd = { ...base.xsd, ...overrides.xsd };
  }
  if (xsdOverrides) {
    base.xsd = { ...base.xsd, ...xsdOverrides };
  }

  return base;
}

test('hasAnafBlockingErrors blochează profil invalid', () => {
  const validation = buildValidation({
    profile: {
      valid: false,
      errors: ['profil invalid'],
      warnings: [],
    },
  });

  assert.equal(hasAnafBlockingErrors(validation), true);
});

test('hasAnafBlockingErrors blochează XSD invalid când validarea a fost executată', () => {
  const validation = buildValidation(undefined, {
    performed: true,
    valid: false,
    errors: ['xsd invalid'],
  });

  assert.equal(hasAnafBlockingErrors(validation), true);
});

test('hasAnafBlockingErrors nu blochează implicit când XSD nu a fost executată', () => {
  const validation = buildValidation(undefined, {
    performed: false,
    valid: null,
    validator: 'none',
    schemaPath: null,
    warnings: ['xsd not performed'],
  });

  assert.equal(hasAnafBlockingErrors(validation), false);
});

test('hasAnafBlockingErrors blochează în strict mode când XSD nu a fost executată', () => {
  const validation = buildValidation(undefined, {
    performed: false,
    valid: null,
    validator: 'none',
    schemaPath: null,
    warnings: ['xsd not performed'],
  });

  assert.equal(hasAnafBlockingErrors(validation, { requireXsdPerformed: true }), true);
});
