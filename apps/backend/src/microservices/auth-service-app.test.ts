import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createAuthServiceApp } from './auth-service-app.js';

async function withRunningAuthService(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = createAuthServiceApp();
  const server = app.listen(0);

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object', 'Nu s-a putut obține adresa serverului auth-service.');
    await run(`http://127.0.0.1:${(address as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

test('auth service exposes health endpoint for extracted runtime', async () => {
  await withRunningAuthService(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.service, 'auth-service');
    assert.equal(payload.status, 'ok');
  });
});

test('auth service keeps invoice routes outside auth runtime boundary', async () => {
  await withRunningAuthService(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/invoices`);

    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.message, 'Resursa nu a fost găsită.');
  });
});

test('auth service keeps login endpoint active with request validation', async () => {
  await withRunningAuthService(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.message, 'Date invalide la autentificare.');
  });
});
