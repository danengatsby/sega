import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
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
  const [selectedPartnerId, setSelectedPartnerId] = useState('');
  const selectedPartner = useMemo(
    () => partners.find((partner) => partner.id === selectedPartnerId) ?? null,
    [partners, selectedPartnerId],
  );

  return (
    <section className="split-layout split-layout-single-column">
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
        <h3 style={{ marginTop: '1rem' }}>Registru parteneri ({partners.length})</h3>
        <label>
          Lista partenerilor
          <select
            className="accounts-overflow-select"
            size={15}
            value={selectedPartnerId}
            onChange={(event) => setSelectedPartnerId(event.target.value)}
          >
            <option value="" disabled>
              Selectează partenerul
            </option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name} · {partner.type} · CUI: {partner.cui ?? '-'} · IBAN: {partner.iban ?? '-'}
              </option>
            ))}
          </select>
        </label>
        {selectedPartner ? (
          <div className="timeline-item journal-entry-preview">
            <header>
              <strong>{selectedPartner.name}</strong>
              <span>{selectedPartner.type}</span>
            </header>
            <div className="journal-entry-preview-lines">
              <div>CUI: {selectedPartner.cui ?? '-'}</div>
              <div>IBAN: {selectedPartner.iban ?? '-'}</div>
              <div>Email: {selectedPartner.email ?? '-'}</div>
              <div>Telefon: {selectedPartner.phone ?? '-'}</div>
            </div>
          </div>
        ) : (
          <p className="muted">Selectează un partener din listă pentru afișarea în container.</p>
        )}
      </article>
    </section>
  );
}
