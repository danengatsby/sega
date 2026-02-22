import type { Role } from '@prisma/client';

type NotificationEventBase = {
  eventId?: string;
  occurredAt?: string;
  companyId: string;
  companyName?: string | null;
  triggeredByUserId?: string | null;
  targetRoles?: Role[];
};

export type InvoiceCreatedNotificationEvent = NotificationEventBase & {
  type: 'INVOICE_CREATED';
  payload: {
    invoiceId: string;
    number: string;
    partnerName: string;
    total: number;
    currency: string;
    issueDate: string;
    dueDate: string;
  };
};

export type InvoicePaidNotificationEvent = NotificationEventBase & {
  type: 'INVOICE_PAID';
  payload: {
    invoiceId: string;
    number: string;
    partnerName: string;
    paidAmount: number;
    currency: string;
    status: string;
    paymentDate: string;
  };
};

export type SupplierInvoiceCreatedNotificationEvent = NotificationEventBase & {
  type: 'SUPPLIER_INVOICE_CREATED';
  payload: {
    supplierInvoiceId: string;
    number: string;
    supplierName: string;
    total: number;
    currency: string;
    dueDate: string;
    approvalStatus: string;
  };
};

export type SupplierInvoicePaidNotificationEvent = NotificationEventBase & {
  type: 'SUPPLIER_INVOICE_PAID';
  payload: {
    supplierInvoiceId: string;
    number: string;
    supplierName: string;
    paidAmount: number;
    currency: string;
    status: string;
    paymentDate: string;
  };
};

export type PayrollRunGeneratedNotificationEvent = NotificationEventBase & {
  type: 'PAYROLL_RUN_GENERATED';
  payload: {
    payrollRunId: string;
    period: string;
    employeeCount: number;
    totalNet: number;
    totalGross: number;
    totalCam: number;
    currency: string;
  };
};

export type RevisalDeliveredNotificationEvent = NotificationEventBase & {
  type: 'REVISAL_DELIVERED';
  payload: {
    deliveryId: string;
    period: string;
    deliveryReference: string;
    channel: string;
    receiptNumber: string | null;
    deliveredAt: string;
  };
};

export type NotificationEvent =
  | InvoiceCreatedNotificationEvent
  | InvoicePaidNotificationEvent
  | SupplierInvoiceCreatedNotificationEvent
  | SupplierInvoicePaidNotificationEvent
  | PayrollRunGeneratedNotificationEvent
  | RevisalDeliveredNotificationEvent;

export type NotificationChannel = 'email' | 'sms' | 'push';

export interface NotificationMessage {
  subject?: string;
  title?: string;
  body: string;
}

export type NotificationTemplateSet = Record<NotificationChannel, NotificationMessage>;
