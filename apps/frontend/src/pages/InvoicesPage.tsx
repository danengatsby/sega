import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
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
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const selectedInvoice = useMemo(
    () => invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? null,
    [invoices, selectedInvoiceId],
  );
  const selectedInvoicePaidAmount = useMemo(
    () => (selectedInvoice ? selectedInvoice.payments.reduce((acc, payment) => acc + toNum(payment.amount), 0) : 0),
    [selectedInvoice, toNum],
  );
  const selectedInvoiceOpenAmount = useMemo(
    () => (selectedInvoice ? Math.max(toNum(selectedInvoice.total) - selectedInvoicePaidAmount, 0) : 0),
    [selectedInvoice, selectedInvoicePaidAmount, toNum],
  );
  const selectedInvoiceLatestReference = useMemo(() => {
    if (!selectedInvoice) {
      return '—';
    }
    const latestPayment = selectedInvoice.payments.reduce<Invoice['payments'][number] | null>((latest, payment) => {
      if (!latest) {
        return payment;
      }
      return new Date(payment.date).getTime() > new Date(latest.date).getTime() ? payment : latest;
    }, null);
    return latestPayment?.reference?.trim() || '—';
  }, [selectedInvoice]);

  return (
    <section className="split-layout split-layout-single-column">
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
        <h3 style={{ marginTop: '1rem' }}>Facturi și încasări</h3>
        <label>
          Lista facturilor
          <select
            className="accounts-overflow-select"
            size={15}
            value={selectedInvoiceId}
            onChange={(event) => setSelectedInvoiceId(event.target.value)}
          >
            <option value="" disabled>
              Selectează factura
            </option>
            {invoices.map((invoice) => {
              const paid = invoice.payments.reduce((acc, payment) => acc + toNum(payment.amount), 0);
              const open = Math.max(toNum(invoice.total) - paid, 0);
              return (
                <option key={invoice.id} value={invoice.id}>
                  {invoice.number} · {invoice.partner.name} · Total {fmtCurrency(toNum(invoice.total))} · Rest{' '}
                  {fmtCurrency(open)} · {invoice.status}
                </option>
              );
            })}
          </select>
        </label>
        {selectedInvoice ? (
          <div className="timeline-item journal-entry-preview">
            <header>
              <strong>{selectedInvoice.number} · {selectedInvoice.partner.name}</strong>
              <span>{new Date(selectedInvoice.dueDate).toLocaleDateString('ro-RO')}</span>
            </header>
            <div className="journal-entry-preview-lines">
              <div>
                Flux: <span className="flow-badge flow-badge-inflow">Încasare</span>
              </div>
              <div>
                Status:{' '}
                <span className={`status status-${selectedInvoice.status.toLowerCase()}`}>{selectedInvoice.status}</span>
              </div>
              <div>
                Total: {fmtCurrency(toNum(selectedInvoice.total))} | Încasat:{' '}
                {fmtCurrency(selectedInvoicePaidAmount)} | Rest: {fmtCurrency(selectedInvoiceOpenAmount)}
              </div>
              <div>Ultima referință: {selectedInvoiceLatestReference}</div>
              <div>
                Încasări: {selectedInvoice.payments.length}
                {selectedInvoice.payments.length > 0
                  ? ` (${selectedInvoice.payments
                      .map((payment) => `${fmtCurrency(toNum(payment.amount))} @ ${new Date(payment.date).toLocaleDateString('ro-RO')}`)
                      .join(', ')})`
                  : ''}
              </div>
            </div>
            {selectedInvoice.status !== 'PAID' && canCollectInvoice ? (
              <button onClick={() => collectInvoice(selectedInvoice)} disabled={busyKey === 'payment-dialog-submit'}>
                Încasează
              </button>
            ) : selectedInvoice.status !== 'PAID' ? (
              <p className="muted">Fără drept încasare</p>
            ) : (
              <p className="muted">Factura este încasată complet.</p>
            )}
          </div>
        ) : (
          <p className="muted">Selectează o factură din listă pentru afișarea în container.</p>
        )}
      </article>
    </section>
  );
}
