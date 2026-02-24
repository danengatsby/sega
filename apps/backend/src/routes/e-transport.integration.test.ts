import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'ETransport!Pass2026';
const EMAIL = `etr-accountant-${RUN_ID}@sega.test`;

let server: Server | null = null;
let baseUrl = '';
let companyId: string | null = null;
let userId: string | null = null;

function extractCookieHeader(response: Response): string {
  const rawCookies = response.headers.getSetCookie();
  return rawCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie && cookie.length > 0))
    .join('; ');
}

async function loginWithCompanyContext(): Promise<string> {
  assert.ok(companyId, 'Compania fixture lipsește pentru testul e-Transport.');
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: EMAIL,
      password: PASSWORD,
    }),
  });

  assert.equal(loginResponse.status, 200, 'Login eșuat pentru fixture accountant');
  const loginCookieHeader = extractCookieHeader(loginResponse);

  const switchResponse = await fetch(`${baseUrl}/api/auth/switch-company`, {
    method: 'POST',
    headers: {
      cookie: loginCookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      companyId,
      makeDefault: true,
      reason: 'e-transport-integration-switch-company',
    }),
  });

  assert.equal(switchResponse.status, 200, 'Switch company eșuat pentru fixture accountant');
  return extractCookieHeader(switchResponse);
}

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server?.on('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const company = await prisma.company.create({
    data: {
      code: `etr-${RUN_ID}`.slice(0, 32),
      name: `ETransport Test ${RUN_ID}`,
      isActive: true,
    },
  });
  companyId = company.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      name: `ETransport User ${RUN_ID}`,
      passwordHash,
      role: Role.ACCOUNTANT,
      mustChangePassword: false,
    },
  });
  userId = user.id;

  await prisma.userCompanyMembership.create({
    data: {
      userId: user.id,
      companyId: company.id,
      role: Role.ACCOUNTANT,
      isDefault: true,
    },
  });
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  if (userId) {
    await prisma.refreshSession.deleteMany({
      where: {
        userId,
      },
    });
  }

  if (companyId) {
    await prisma.eTransportShipment.deleteMany({
      where: {
        companyId,
      },
    });
  }

  if (userId) {
    await prisma.auditLog.updateMany({
      where: {
        userId,
      },
      data: {
        userId: null,
      },
    });
  }

  if (companyId) {
    await prisma.auditLog.updateMany({
      where: {
        companyId,
      },
      data: {
        companyId: null,
      },
    });
  }

  if (userId) {
    await prisma.userCompanyMembership.deleteMany({
      where: {
        userId,
      },
    });

    await prisma.user.delete({
      where: {
        id: userId,
      },
    });
  }

  if (companyId) {
    await prisma.company.delete({
      where: {
        id: companyId,
      },
    });
  }
});

test('e-Transport: generează UIT, monitorizează transportul și validează tranzițiile de status', async () => {
  const cookieHeader = await loginWithCompanyContext();

  const createResponse = await fetch(`${baseUrl}/api/e-transport/shipments`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      shipmentReference: `SH-${RUN_ID}`,
      vehicleNumber: 'B-123-ABC',
      carrierName: 'Carrier Test SRL',
      originLocation: 'Bucuresti',
      destinationLocation: 'Cluj-Napoca',
      goodsDescription: 'Transport produse alimentare ambalate',
      goodsCategory: 'BUNURI_RISC_FISCAL',
      quantity: 42,
      unit: 'BUC',
      grossWeightKg: 780.5,
    }),
  });

  assert.equal(createResponse.status, 201, 'Crearea transportului cu UIT trebuie să returneze 201');
  const created = (await createResponse.json()) as {
    id: string;
    uit: string;
    status: string;
  };
  assert.match(created.uit, /^UIT-\d{8}-[A-F0-9]{10}$/);
  assert.equal(created.status, 'GENERATED');

  const listResponse = await fetch(`${baseUrl}/api/e-transport/shipments`, {
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(listResponse.status, 200, 'Listarea transporturilor trebuie să returneze 200');
  const listPayload = (await listResponse.json()) as Array<{ id: string }>;
  assert.equal(listPayload.some((shipment) => shipment.id === created.id), true);

  const monitorResponse = await fetch(`${baseUrl}/api/e-transport/shipments/monitor`, {
    headers: {
      cookie: cookieHeader,
    },
  });
  assert.equal(monitorResponse.status, 200, 'Monitorizarea transporturilor trebuie să returneze 200');
  const monitorPayload = (await monitorResponse.json()) as {
    counters: Record<string, number>;
    activeShipments: Array<{ id: string }>;
  };
  assert.ok((monitorPayload.counters.GENERATED ?? 0) >= 1);
  assert.equal(monitorPayload.activeShipments.some((shipment) => shipment.id === created.id), true);

  const inTransitResponse = await fetch(`${baseUrl}/api/e-transport/shipments/${created.id}/status`, {
    method: 'PATCH',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      status: 'IN_TRANSIT',
      statusReason: 'Transportul a plecat din depozit',
    }),
  });
  assert.equal(inTransitResponse.status, 200, 'Tranziția GENERATED -> IN_TRANSIT trebuie să fie permisă');
  const inTransitPayload = (await inTransitResponse.json()) as {
    status: string;
    actualDepartureAt: string | null;
  };
  assert.equal(inTransitPayload.status, 'IN_TRANSIT');
  assert.ok(inTransitPayload.actualDepartureAt);

  const deliveredResponse = await fetch(`${baseUrl}/api/e-transport/shipments/${created.id}/status`, {
    method: 'PATCH',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      status: 'DELIVERED',
      statusReason: 'Marfa recepționată la destinație',
    }),
  });
  assert.equal(deliveredResponse.status, 200, 'Tranziția IN_TRANSIT -> DELIVERED trebuie să fie permisă');
  const deliveredPayload = (await deliveredResponse.json()) as {
    status: string;
    actualArrivalAt: string | null;
  };
  assert.equal(deliveredPayload.status, 'DELIVERED');
  assert.ok(deliveredPayload.actualArrivalAt);

  const invalidTransitionResponse = await fetch(`${baseUrl}/api/e-transport/shipments/${created.id}/status`, {
    method: 'PATCH',
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      status: 'CANCELLED',
      statusReason: 'Nu mai este relevant',
    }),
  });
  assert.equal(invalidTransitionResponse.status, 409, 'Tranziția DELIVERED -> CANCELLED trebuie respinsă');

  const [createAudit, statusAudit] = await Promise.all([
    prisma.auditLog.findFirst({
      where: {
        action: 'E_TRANSPORT_CREATE',
        recordId: created.id,
      },
    }),
    prisma.auditLog.findFirst({
      where: {
        action: 'E_TRANSPORT_STATUS_UPDATE',
        recordId: created.id,
      },
      orderBy: [{ timestamp: 'desc' }],
    }),
  ]);

  assert.ok(createAudit, 'Crearea transportului trebuie să scrie audit log');
  assert.ok(statusAudit, 'Actualizarea statusului transportului trebuie să scrie audit log');
});
