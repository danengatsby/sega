import assert from 'node:assert/strict';
import test from 'node:test';
import { ETransportShipmentStatus } from '@prisma/client';
import { canTransitionETransportStatus, generateUitCode, isValidUitCode } from './e-transport.js';

test('generateUitCode produce cod UIT valid', () => {
  const uit = generateUitCode(new Date('2026-02-24T10:00:00.000Z'));
  assert.equal(isValidUitCode(uit), true);
  assert.equal(uit.startsWith('UIT-20260224-'), true);
});

test('canTransitionETransportStatus validează lifecycle-ul transportului', () => {
  assert.equal(canTransitionETransportStatus(ETransportShipmentStatus.GENERATED, ETransportShipmentStatus.IN_TRANSIT), true);
  assert.equal(canTransitionETransportStatus(ETransportShipmentStatus.GENERATED, ETransportShipmentStatus.DELIVERED), false);
  assert.equal(canTransitionETransportStatus(ETransportShipmentStatus.IN_TRANSIT, ETransportShipmentStatus.DELIVERED), true);
  assert.equal(canTransitionETransportStatus(ETransportShipmentStatus.DELIVERED, ETransportShipmentStatus.CANCELLED), false);
});
