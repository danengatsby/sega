import type { NotificationEvent, NotificationTemplateSet } from './types.js';

function formatMoney(value: number, currency: string): string {
  return `${value.toFixed(2)} ${currency}`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString().slice(0, 10);
}

export function renderNotificationTemplates(event: NotificationEvent): NotificationTemplateSet {
  switch (event.type) {
    case 'INVOICE_CREATED': {
      const summary = `Factură ${event.payload.number} emisă către ${event.payload.partnerName} (${formatMoney(event.payload.total, event.payload.currency)}), scadență ${formatDate(event.payload.dueDate)}.`;
      return {
        email: {
          subject: `[SEGA] Factură emisă ${event.payload.number}`,
          body: summary,
        },
        sms: {
          body: `SEGA: ${event.payload.number} emisă, total ${formatMoney(event.payload.total, event.payload.currency)}, scadență ${formatDate(event.payload.dueDate)}.`,
        },
        push: {
          title: 'Factură emisă',
          body: summary,
        },
      };
    }
    case 'INVOICE_PAID': {
      const summary = `Factură ${event.payload.number} încasată (${formatMoney(event.payload.paidAmount, event.payload.currency)}), status curent ${event.payload.status}.`;
      return {
        email: {
          subject: `[SEGA] Factură încasată ${event.payload.number}`,
          body: summary,
        },
        sms: {
          body: `SEGA: încasare ${event.payload.number}, ${formatMoney(event.payload.paidAmount, event.payload.currency)}, status ${event.payload.status}.`,
        },
        push: {
          title: 'Factură încasată',
          body: summary,
        },
      };
    }
    case 'SUPPLIER_INVOICE_CREATED': {
      const summary = `Factură furnizor ${event.payload.number} (${event.payload.supplierName}) înregistrată: ${formatMoney(event.payload.total, event.payload.currency)}. Status aprobare ${event.payload.approvalStatus}.`;
      return {
        email: {
          subject: `[SEGA] Factură furnizor nouă ${event.payload.number}`,
          body: summary,
        },
        sms: {
          body: `SEGA: AP ${event.payload.number} ${formatMoney(event.payload.total, event.payload.currency)}, aprobare ${event.payload.approvalStatus}.`,
        },
        push: {
          title: 'Factură furnizor nouă',
          body: summary,
        },
      };
    }
    case 'SUPPLIER_INVOICE_PAID': {
      const summary = `Plată furnizor înregistrată pentru ${event.payload.number}: ${formatMoney(event.payload.paidAmount, event.payload.currency)}. Status ${event.payload.status}.`;
      return {
        email: {
          subject: `[SEGA] Factură furnizor plătită ${event.payload.number}`,
          body: summary,
        },
        sms: {
          body: `SEGA: plată AP ${event.payload.number}, ${formatMoney(event.payload.paidAmount, event.payload.currency)}, status ${event.payload.status}.`,
        },
        push: {
          title: 'Plată furnizor',
          body: summary,
        },
      };
    }
    case 'PAYROLL_RUN_GENERATED': {
      const summary = `Statul de salarii pentru ${event.payload.period} a fost generat: ${event.payload.employeeCount} angajați, net ${formatMoney(event.payload.totalNet, event.payload.currency)}, CAM ${formatMoney(event.payload.totalCam, event.payload.currency)}.`;
      return {
        email: {
          subject: `[SEGA] Stat salarii generat ${event.payload.period}`,
          body: summary,
        },
        sms: {
          body: `SEGA: payroll ${event.payload.period}, ${event.payload.employeeCount} angajați, net ${formatMoney(event.payload.totalNet, event.payload.currency)}.`,
        },
        push: {
          title: 'Payroll generat',
          body: summary,
        },
      };
    }
    case 'REVISAL_DELIVERED': {
      const receiptSuffix = event.payload.receiptNumber ? `, recipisă ${event.payload.receiptNumber}` : '';
      const summary = `Export Revisal ${event.payload.deliveryReference} (${event.payload.period}) marcat ca livrat prin ${event.payload.channel}${receiptSuffix}.`;
      return {
        email: {
          subject: `[SEGA] Revisal livrat ${event.payload.period}`,
          body: summary,
        },
        sms: {
          body: `SEGA: Revisal ${event.payload.period} livrat (${event.payload.channel})${receiptSuffix}.`,
        },
        push: {
          title: 'Revisal livrat',
          body: summary,
        },
      };
    }
    default: {
      const _exhaustiveCheck: never = event;
      throw new Error(`Template lipsă pentru tipul de notificare: ${JSON.stringify(_exhaustiveCheck)}`);
    }
  }
}
