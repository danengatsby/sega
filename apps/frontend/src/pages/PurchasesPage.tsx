import type { Dispatch, SetStateAction } from 'react';
import type { Partner, PurchaseApprovalDelegation, PurchaseApproverUser, SupplierInvoice } from '../types';

interface SupplierInvoiceFormState {
  number: string;
  supplierId: string;
  receivedDate: string;
  dueDate: string;
  subtotal: string;
  vat: string;
  description: string;
}

interface PurchaseDelegationFormState {
  fromUserId: string;
  toUserId: string;
  endsAt: string;
  reason: string;
}

interface PurchasesPageProps {
  supplierInvoiceForm: SupplierInvoiceFormState;
  setSupplierInvoiceForm: Dispatch<SetStateAction<SupplierInvoiceFormState>>;
  createSupplierInvoice: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canCreateSupplierInvoice: boolean;
  busyKey: string | null;
  suppliers: Partner[];
  supplierInvoices: SupplierInvoice[];
  approveSupplierInvoice: (invoice: SupplierInvoice) => void;
  approveSupplierInvoiceMobile: (invoice: SupplierInvoice) => void;
  rejectSupplierInvoice: (invoice: SupplierInvoice) => Promise<void>;
  canApproveSupplierInvoice: boolean;
  canApproveSupplierInvoiceMobile: boolean;
  canRejectSupplierInvoice: boolean;
  paySupplierInvoice: (invoice: SupplierInvoice) => void;
  canPaySupplierInvoice: boolean;
  purchaseDelegationForm: PurchaseDelegationFormState;
  setPurchaseDelegationForm: Dispatch<SetStateAction<PurchaseDelegationFormState>>;
  createPurchaseDelegation: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canDelegateSupplierInvoiceApproval: boolean;
  purchaseApprovers: PurchaseApproverUser[];
  purchaseDelegations: PurchaseApprovalDelegation[];
  fmtCurrency: (value: number) => string;
  toNum: (value: string | number) => number;
}

function approvalLabel(invoice: SupplierInvoice): string {
  if (invoice.approvalStatus === 'APPROVED') {
    return 'APROBATĂ';
  }
  if (invoice.approvalStatus === 'REJECTED') {
    return 'RESPINSĂ';
  }
  return `NIVEL ${invoice.approvalCurrentLevel}/${invoice.approvalRequiredLevel}`;
}

export function PurchasesPage({
  supplierInvoiceForm,
  setSupplierInvoiceForm,
  createSupplierInvoice,
  canCreateSupplierInvoice,
  busyKey,
  suppliers,
  supplierInvoices,
  approveSupplierInvoice,
  approveSupplierInvoiceMobile,
  rejectSupplierInvoice,
  canApproveSupplierInvoice,
  canApproveSupplierInvoiceMobile,
  canRejectSupplierInvoice,
  paySupplierInvoice,
  canPaySupplierInvoice,
  purchaseDelegationForm,
  setPurchaseDelegationForm,
  createPurchaseDelegation,
  canDelegateSupplierInvoiceApproval,
  purchaseApprovers,
  purchaseDelegations,
  fmtCurrency,
  toNum,
}: PurchasesPageProps) {
  return (
    <section className="split-layout">
      <article className="panel">
        <h3>Administrare achiziții</h3>
        {canCreateSupplierInvoice ? (
          <form onSubmit={(event) => void createSupplierInvoice(event)} className="stack-form">
            <label>
              Număr factură
              <input
                value={supplierInvoiceForm.number}
                onChange={(event) => setSupplierInvoiceForm((prev) => ({ ...prev, number: event.target.value }))}
                required
              />
            </label>
            <label>
              Furnizor
              <select
                value={supplierInvoiceForm.supplierId}
                onChange={(event) => setSupplierInvoiceForm((prev) => ({ ...prev, supplierId: event.target.value }))}
                required
              >
                <option value="">Selectează furnizor</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-fields">
              <label>
                Data primire
                <input
                  type="datetime-local"
                  value={supplierInvoiceForm.receivedDate}
                  onChange={(event) => setSupplierInvoiceForm((prev) => ({ ...prev, receivedDate: event.target.value }))}
                  required
                />
              </label>
              <label>
                Scadență
                <input
                  type="datetime-local"
                  value={supplierInvoiceForm.dueDate}
                  onChange={(event) => setSupplierInvoiceForm((prev) => ({ ...prev, dueDate: event.target.value }))}
                  required
                />
              </label>
            </div>
            <div className="inline-fields">
              <label>
                Subtotal
                <input
                  type="number"
                  step="0.01"
                  value={supplierInvoiceForm.subtotal}
                  onChange={(event) => setSupplierInvoiceForm((prev) => ({ ...prev, subtotal: event.target.value }))}
                  required
                />
              </label>
              <label>
                TVA
                <input
                  type="number"
                  step="0.01"
                  value={supplierInvoiceForm.vat}
                  onChange={(event) => setSupplierInvoiceForm((prev) => ({ ...prev, vat: event.target.value }))}
                  required
                />
              </label>
            </div>
            <label>
              Descriere
              <input
                value={supplierInvoiceForm.description}
                onChange={(event) => setSupplierInvoiceForm((prev) => ({ ...prev, description: event.target.value }))}
                placeholder="Detalii opționale"
              />
            </label>
            <button type="submit" disabled={busyKey === 'supplier-invoice'}>
              {busyKey === 'supplier-invoice' ? 'Salvare...' : 'Înregistrează factură furnizor'}
            </button>
          </form>
        ) : (
          <p className="muted">Ai acces doar de citire pe facturi furnizor.</p>
        )}

        <h3 style={{ marginTop: '1rem' }}>Delegare aprobare AP</h3>
        {canDelegateSupplierInvoiceApproval ? (
          <form onSubmit={(event) => void createPurchaseDelegation(event)} className="stack-form">
            <div className="inline-fields">
              <label>
                Delegator
                <select
                  value={purchaseDelegationForm.fromUserId}
                  onChange={(event) => setPurchaseDelegationForm((prev) => ({ ...prev, fromUserId: event.target.value }))}
                  required
                >
                  {purchaseApprovers.map((approver) => (
                    <option key={approver.id} value={approver.id}>
                      {approver.name} ({approver.role})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Delegat către
                <select
                  value={purchaseDelegationForm.toUserId}
                  onChange={(event) => setPurchaseDelegationForm((prev) => ({ ...prev, toUserId: event.target.value }))}
                  required
                >
                  <option value="">Selectează utilizator</option>
                  {purchaseApprovers
                    .filter((approver) => approver.id !== purchaseDelegationForm.fromUserId)
                    .map((approver) => (
                      <option key={approver.id} value={approver.id}>
                        {approver.name} ({approver.role})
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label>
              Valabil până la
              <input
                type="datetime-local"
                value={purchaseDelegationForm.endsAt}
                onChange={(event) => setPurchaseDelegationForm((prev) => ({ ...prev, endsAt: event.target.value }))}
                required
              />
            </label>
            <label>
              Motiv
              <input
                value={purchaseDelegationForm.reason}
                onChange={(event) => setPurchaseDelegationForm((prev) => ({ ...prev, reason: event.target.value }))}
              />
            </label>
            <button type="submit" disabled={busyKey === 'purchase-delegation'}>
              {busyKey === 'purchase-delegation' ? 'Salvare...' : 'Creează delegare'}
            </button>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a delega aprobări AP.</p>
        )}

        <div style={{ marginTop: '1rem' }}>
          <h4>Delegări active ({purchaseDelegations.length})</h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>De la</th>
                  <th>Către</th>
                  <th>Start</th>
                  <th>Sfârșit</th>
                  <th>Motiv</th>
                </tr>
              </thead>
              <tbody>
                {purchaseDelegations.map((delegation) => (
                  <tr key={delegation.id}>
                    <td>{delegation.fromUser.name}</td>
                    <td>{delegation.toUser.name}</td>
                    <td>{new Date(delegation.startsAt).toLocaleString('ro-RO')}</td>
                    <td>{new Date(delegation.endsAt).toLocaleString('ro-RO')}</td>
                    <td>{delegation.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </article>

      <article className="panel">
        <h3>Facturi furnizori: aprobare + plăți</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Număr</th>
                <th>Furnizor</th>
                <th>Total</th>
                <th>Primire</th>
                <th>Scadență</th>
                <th>Status</th>
                <th>Aprobare</th>
                <th>Motiv respingere</th>
                <th>Acțiuni</th>
              </tr>
            </thead>
            <tbody>
              {supplierInvoices.map((invoice) => {
                const paid = invoice.payments.reduce((acc, payment) => acc + toNum(payment.amount), 0);
                const open = Math.max(toNum(invoice.total) - paid, 0);
                const canPay = invoice.status !== 'PAID' && open > 0 && invoice.approvalStatus === 'APPROVED';

                return (
                  <tr key={invoice.id}>
                    <td>{invoice.number}</td>
                    <td>{invoice.supplier.name}</td>
                    <td>
                      {fmtCurrency(toNum(invoice.total))}
                      <small className="muted"> Rest: {fmtCurrency(open)}</small>
                    </td>
                    <td>{new Date(invoice.receivedDate).toLocaleDateString('ro-RO')}</td>
                    <td>{new Date(invoice.dueDate).toLocaleDateString('ro-RO')}</td>
                    <td>
                      <span className={`status status-${invoice.status.toLowerCase()}`}>{invoice.status}</span>
                    </td>
                    <td>
                      <span className={`status status-${invoice.approvalStatus.toLowerCase()}`}>{approvalLabel(invoice)}</span>
                    </td>
                    <td>{invoice.approvalRejectedReason || '—'}</td>
                    <td>
                      <div className="button-row">
                        {canApproveSupplierInvoice && invoice.approvalStatus !== 'APPROVED' && invoice.approvalStatus !== 'REJECTED' ? (
                          <button onClick={() => approveSupplierInvoice(invoice)} disabled={busyKey === 'supplier-approve'}>
                            Aprobă
                          </button>
                        ) : null}
                        {canApproveSupplierInvoiceMobile &&
                        invoice.approvalStatus !== 'APPROVED' &&
                        invoice.approvalStatus !== 'REJECTED' ? (
                          <button
                            onClick={() => approveSupplierInvoiceMobile(invoice)}
                            disabled={busyKey === 'supplier-approve-mobile'}
                          >
                            Aprobă mobil
                          </button>
                        ) : null}
                        {canRejectSupplierInvoice &&
                        invoice.approvalStatus !== 'APPROVED' &&
                        invoice.approvalStatus !== 'REJECTED' ? (
                          <button onClick={() => void rejectSupplierInvoice(invoice)} disabled={busyKey === 'supplier-reject'}>
                            Respinge
                          </button>
                        ) : null}
                        {canPay && canPaySupplierInvoice ? (
                          <button onClick={() => paySupplierInvoice(invoice)} disabled={busyKey === 'payment-dialog-submit'}>
                            Plătește
                          </button>
                        ) : canPay && !canPaySupplierInvoice ? (
                          <span className="muted">Fără drept plată</span>
                        ) : invoice.approvalStatus !== 'APPROVED' ? (
                          <span className="muted">Așteaptă aprobare</span>
                        ) : (
                          <span className="muted">Complet</span>
                        )}
                      </div>
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
