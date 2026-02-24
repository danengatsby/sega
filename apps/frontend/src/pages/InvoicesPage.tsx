import type { Dispatch, SetStateAction } from 'react';
import type { Invoice, Partner } from '../types';

interface InvoiceFormState {
  number: string;
  partnerId: string;
  dueDate: string;
  subtotal: string;
  vat: string;
  description: string;
}

interface InvoicesPageProps {
  invoiceForm: InvoiceFormState;
  setInvoiceForm: Dispatch<SetStateAction<InvoiceFormState>>;
  createInvoice: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canCreateInvoice: boolean;
  busyKey: string | null;
  partners: Partner[];
  invoices: Invoice[];
  collectInvoice: (invoice: Invoice) => void;
  canCollectInvoice: boolean;
  fmtCurrency: (value: number) => string;
  toNum: (value: string | number) => number;
}

export function InvoicesPage({
  invoiceForm,
  setInvoiceForm,
  createInvoice,
  canCreateInvoice,
  busyKey,
  partners,
  invoices,
  collectInvoice,
  canCollectInvoice,
  fmtCurrency,
  toNum,
}: InvoicesPageProps) {
  return (
    <section className="split-layout">
      <article className="panel">
        <h3>Administrare facturi client</h3>
        {canCreateInvoice ? (
          <form onSubmit={(event) => void createInvoice(event)} className="stack-form">
            <label>
              Număr factură
              <input
                value={invoiceForm.number}
                onChange={(event) => setInvoiceForm((prev) => ({ ...prev, number: event.target.value }))}
                required
              />
            </label>
            <label>
              Client
              <select
                value={invoiceForm.partnerId}
                onChange={(event) => setInvoiceForm((prev) => ({ ...prev, partnerId: event.target.value }))}
                required
              >
                <option value="">Selectează client</option>
                {partners.map((partner) => (
                  <option key={partner.id} value={partner.id}>
                    {partner.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Scadență
              <input
                type="datetime-local"
                value={invoiceForm.dueDate}
                onChange={(event) => setInvoiceForm((prev) => ({ ...prev, dueDate: event.target.value }))}
                required
              />
            </label>
            <div className="inline-fields">
              <label>
                Subtotal
                <input
                  type="number"
                  step="0.01"
                  value={invoiceForm.subtotal}
                  onChange={(event) => setInvoiceForm((prev) => ({ ...prev, subtotal: event.target.value }))}
                  required
                />
              </label>
              <label>
                TVA
                <input
                  type="number"
                  step="0.01"
                  value={invoiceForm.vat}
                  onChange={(event) => setInvoiceForm((prev) => ({ ...prev, vat: event.target.value }))}
                  required
                />
              </label>
            </div>
            <button type="submit" disabled={busyKey === 'invoice'}>
              {busyKey === 'invoice' ? 'Emitere...' : 'Emite factură'}
            </button>
          </form>
        ) : (
          <p className="muted">Ai acces doar de citire pe facturi client.</p>
        )}
      </article>

      <article className="panel">
        <h3>Facturi și încasări</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Număr</th>
                <th>Client</th>
                <th>Flux</th>
                <th>Total</th>
                <th>Scadent</th>
                <th>Status</th>
                <th>Ultima referință</th>
                <th>Acțiuni</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => {
                const paid = invoice.payments.reduce((acc, payment) => acc + toNum(payment.amount), 0);
                const open = Math.max(toNum(invoice.total) - paid, 0);
                const latestPayment = invoice.payments.reduce<Invoice['payments'][number] | null>((latest, payment) => {
                  if (!latest) {
                    return payment;
                  }

                  return new Date(payment.date).getTime() > new Date(latest.date).getTime() ? payment : latest;
                }, null);
                const latestReference = latestPayment?.reference?.trim() || '—';

                return (
                  <tr key={invoice.id}>
                    <td>{invoice.number}</td>
                    <td>{invoice.partner.name}</td>
                    <td>
                      <span className="flow-badge flow-badge-inflow">Încasare</span>
                    </td>
                    <td>
                      {fmtCurrency(toNum(invoice.total))}
                      <small className="muted"> Rest: {fmtCurrency(open)}</small>
                    </td>
                    <td>{new Date(invoice.dueDate).toLocaleDateString('ro-RO')}</td>
                    <td>
                      <span className={`status status-${invoice.status.toLowerCase()}`}>{invoice.status}</span>
                    </td>
                    <td>{latestReference}</td>
                    <td>
                      {invoice.status !== 'PAID' && canCollectInvoice ? (
                        <button onClick={() => collectInvoice(invoice)} disabled={busyKey === 'payment-dialog-submit'}>
                          Încasează
                        </button>
                      ) : invoice.status !== 'PAID' ? (
                        <span className="muted">Fără drept încasare</span>
                      ) : (
                        <span className="muted">Complet</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
