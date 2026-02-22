import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderNotificationTemplates } from './templates.js';
import type { NotificationEvent } from './types.js';

test('renderNotificationTemplates pentru INVOICE_CREATED include numărul și totalul', () => {
  const event: NotificationEvent = {
    type: 'INVOICE_CREATED',
    companyId: 'company-1',
    payload: {
      invoiceId: 'inv-1',
      number: 'F-1001',
      partnerName: 'Client SRL',
      total: 1190,
      currency: 'RON',
      issueDate: '2026-02-22T09:00:00.000Z',
      dueDate: '2026-03-05T00:00:00.000Z',
    },
  };

  const templates = renderNotificationTemplates(event);
  assert.ok(templates.email.subject?.includes('F-1001'));
  assert.ok(templates.email.body.includes('1190.00 RON'));
  assert.ok(templates.sms.body.includes('scadență 2026-03-05'));
});

test('renderNotificationTemplates pentru PAYROLL_RUN_GENERATED include CAM și numărul de angajați', () => {
  const event: NotificationEvent = {
    type: 'PAYROLL_RUN_GENERATED',
    companyId: 'company-1',
    payload: {
      payrollRunId: 'run-1',
      period: '2026-02',
      employeeCount: 17,
      totalNet: 82345.5,
      totalGross: 140000,
      totalCam: 3150,
      currency: 'RON',
    },
  };

  const templates = renderNotificationTemplates(event);
  assert.ok(templates.email.subject?.includes('2026-02'));
  assert.ok(templates.email.body.includes('17 angajați'));
  assert.ok(templates.push.body.includes('3150.00 RON'));
});

test('renderNotificationTemplates pentru REVISAL_DELIVERED include canalul de livrare', () => {
  const event: NotificationEvent = {
    type: 'REVISAL_DELIVERED',
    companyId: 'company-1',
    payload: {
      deliveryId: 'rev-1',
      period: '2026-02',
      deliveryReference: 'REV-202602-ABC123',
      channel: 'WEB_PORTAL',
      receiptNumber: 'RCP-9988',
      deliveredAt: '2026-02-22T10:00:00.000Z',
    },
  };

  const templates = renderNotificationTemplates(event);
  assert.ok(templates.email.body.includes('WEB_PORTAL'));
  assert.ok(templates.sms.body.includes('RCP-9988'));
});
