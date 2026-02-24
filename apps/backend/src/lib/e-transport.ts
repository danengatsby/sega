import { ETransportShipmentStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';

const UIT_REGEX = /^UIT-\d{8}-[A-F0-9]{10}$/;

const ALLOWED_STATUS_TRANSITIONS: Record<ETransportShipmentStatus, ETransportShipmentStatus[]> = {
  GENERATED: [ETransportShipmentStatus.IN_TRANSIT, ETransportShipmentStatus.CANCELLED],
  IN_TRANSIT: [ETransportShipmentStatus.DELIVERED, ETransportShipmentStatus.CANCELLED],
  DELIVERED: [],
  CANCELLED: [],
};

function utcDatePart(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function generateUitCode(now: Date = new Date()): string {
  const datePart = utcDatePart(now);
  const entropyPart = randomBytes(5).toString('hex').toUpperCase();
  return `UIT-${datePart}-${entropyPart}`;
}

export function isValidUitCode(value: string): boolean {
  return UIT_REGEX.test(value.trim());
}

export function canTransitionETransportStatus(
  currentStatus: ETransportShipmentStatus,
  nextStatus: ETransportShipmentStatus,
): boolean {
  if (currentStatus === nextStatus) {
    return true;
  }
  return ALLOWED_STATUS_TRANSITIONS[currentStatus].includes(nextStatus);
}
