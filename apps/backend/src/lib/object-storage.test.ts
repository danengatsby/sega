import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildS3Uri, parseS3Uri } from './object-storage.js';

test('buildS3Uri + parseS3Uri fac round-trip pentru locatorul object storage', () => {
  const uri = buildS3Uri({
    bucket: 'efactura',
    key: 'efactura/signed/company-1/invoice-1/file.xml',
  });

  assert.equal(uri, 's3://efactura/efactura/signed/company-1/invoice-1/file.xml');
  assert.deepEqual(parseS3Uri(uri), {
    bucket: 'efactura',
    key: 'efactura/signed/company-1/invoice-1/file.xml',
  });
});

test('parseS3Uri respinge valori invalide', () => {
  assert.equal(parseS3Uri(''), null);
  assert.equal(parseS3Uri('s3://'), null);
  assert.equal(parseS3Uri('s3://efactura'), null);
  assert.equal(parseS3Uri('s3:///file.xml'), null);
  assert.equal(parseS3Uri('/tmp/file.xml'), null);
});
