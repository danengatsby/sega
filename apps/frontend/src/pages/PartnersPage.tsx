import type { Dispatch, SetStateAction } from 'react';
import type { Partner } from '../types';

interface PartnerFormState {
  name: string;
  type: Partner['type'];
  cui: string;
  iban: string;
  email: string;
  phone: string;
}

interface PartnersPageProps {
  partnerForm: PartnerFormState;
  setPartnerForm: Dispatch<SetStateAction<PartnerFormState>>;
  createPartner: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canCreatePartner: boolean;
  busyKey: string | null;
  partners: Partner[];
}

export function PartnersPage({
  partnerForm,
  setPartnerForm,
  createPartner,
  canCreatePartner,
  busyKey,
  partners,
}: PartnersPageProps) {
  return (
    <section className="split-layout">
      <article className="panel">
        <h3>Administrare parteneri</h3>
        {canCreatePartner ? (
          <form onSubmit={(event) => void createPartner(event)} className="stack-form">
            <label>
              Nume
              <input
                value={partnerForm.name}
                onChange={(event) => setPartnerForm((prev) => ({ ...prev, name: event.target.value }))}
                required
              />
            </label>
            <label>
              Tip
              <select
                value={partnerForm.type}
                onChange={(event) => setPartnerForm((prev) => ({ ...prev, type: event.target.value as Partner['type'] }))}
              >
                <option value="CUSTOMER">Client</option>
                <option value="SUPPLIER">Furnizor</option>
                <option value="BOTH">Client/Furnizor</option>
              </select>
            </label>
            <label>
              CUI
              <input
                value={partnerForm.cui}
                onChange={(event) => setPartnerForm((prev) => ({ ...prev, cui: event.target.value }))}
              />
            </label>
            <label>
              IBAN
              <input
                value={partnerForm.iban}
                onChange={(event) => setPartnerForm((prev) => ({ ...prev, iban: event.target.value }))}
              />
            </label>
            <button type="submit" disabled={busyKey === 'partner'}>
              {busyKey === 'partner' ? 'Salvare...' : 'Salvează partener'}
            </button>
          </form>
        ) : (
          <p className="muted">Ai acces doar de citire pe modulul de parteneri.</p>
        )}
      </article>

      <article className="panel">
        <h3>Registru parteneri ({partners.length})</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nume</th>
                <th>Tip</th>
                <th>CUI</th>
                <th>IBAN</th>
              </tr>
            </thead>
            <tbody>
              {partners.map((partner) => (
                <tr key={partner.id}>
                  <td>{partner.name}</td>
                  <td>{partner.type}</td>
                  <td>{partner.cui ?? '-'}</td>
                  <td>{partner.iban ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
