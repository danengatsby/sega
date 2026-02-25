import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { RevisalDelivery, RevisalDeliveryChannel } from '../types';

interface RevisalGenerateFormState {
  deliveryReference: string;
}

interface RevisalDeliverFormState {
  exportId: string;
  channel: RevisalDeliveryChannel;
  receiptNumber: string;
  deliveredAt: string;
}

interface RevisalPageProps {
  revisalGenerateForm: RevisalGenerateFormState;
  setRevisalGenerateForm: Dispatch<SetStateAction<RevisalGenerateFormState>>;
  generateRevisalExport: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  selectedPeriod: string;
  revisalDeliverForm: RevisalDeliverFormState;
  setRevisalDeliverForm: Dispatch<SetStateAction<RevisalDeliverFormState>>;
  markRevisalDelivered: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canManageRevisal: boolean;
  busyKey: string | null;
  revisalExports: RevisalDelivery[];
  downloadRevisalXml: (delivery: RevisalDelivery) => Promise<void>;
}

const CHANNEL_LABEL: Record<RevisalDeliveryChannel, string> = {
  WEB_PORTAL: 'Portal Revisal',
  EMAIL: 'Email',
  SFTP: 'SFTP',
  MANUAL_UPLOAD: 'Upload manual',
  OTHER: 'Alt canal',
};

function toLocalDateTime(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  return new Date(value).toLocaleString('ro-RO');
}

function toCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function RevisalPage({
  revisalGenerateForm,
  setRevisalGenerateForm,
  generateRevisalExport,
  selectedPeriod,
  revisalDeliverForm,
  setRevisalDeliverForm,
  markRevisalDelivered,
  canManageRevisal,
  busyKey,
  revisalExports,
  downloadRevisalXml,
}: RevisalPageProps) {
  const pendingDeliveries = revisalExports.filter((entry) => entry.status !== 'DELIVERED');
  const [selectedRevisalExportId, setSelectedRevisalExportId] = useState('');
  const selectedRevisalExport = useMemo(
    () => revisalExports.find((entry) => entry.id === selectedRevisalExportId) ?? null,
    [revisalExports, selectedRevisalExportId],
  );

  return (
    <section className="split-layout split-layout-single-column">
      <article className="panel">
        <h3>Generare export Revisal</h3>
        {canManageRevisal ? (
          <form onSubmit={(event) => void generateRevisalExport(event)} className="stack-form">
            <p className="muted">Perioadă activă: {selectedPeriod}</p>
            <label>
              Referință livrare (opțional)
              <input
                value={revisalGenerateForm.deliveryReference}
                onChange={(event) =>
                  setRevisalGenerateForm((prev) => ({
                    ...prev,
                    deliveryReference: event.target.value,
                  }))
                }
                placeholder="Ex: REV-202602-LOT1"
              />
            </label>
            <button type="submit" disabled={busyKey === 'revisal-generate'}>
              {busyKey === 'revisal-generate' ? 'Generare...' : 'Generează export Revisal'}
            </button>
          </form>
        ) : (
          <p className="muted">Ai acces doar de citire pe fluxul Revisal.</p>
        )}

        <h3 style={{ marginTop: '1rem' }}>Confirmare livrare</h3>
        {canManageRevisal ? (
          pendingDeliveries.length > 0 ? (
            <form onSubmit={(event) => void markRevisalDelivered(event)} className="stack-form">
              <label>
                Export de livrat
                <select
                  value={revisalDeliverForm.exportId}
                  onChange={(event) =>
                    setRevisalDeliverForm((prev) => ({
                      ...prev,
                      exportId: event.target.value,
                    }))
                  }
                  required
                >
                  <option value="">Selectează export</option>
                  {pendingDeliveries.map((delivery) => (
                    <option key={delivery.id} value={delivery.id}>
                      {delivery.period} | {delivery.deliveryReference} | {delivery.status}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Canal livrare
                <select
                  value={revisalDeliverForm.channel}
                  onChange={(event) =>
                    setRevisalDeliverForm((prev) => ({
                      ...prev,
                      channel: event.target.value as RevisalDeliveryChannel,
                    }))
                  }
                >
                  <option value="WEB_PORTAL">{CHANNEL_LABEL.WEB_PORTAL}</option>
                  <option value="EMAIL">{CHANNEL_LABEL.EMAIL}</option>
                  <option value="SFTP">{CHANNEL_LABEL.SFTP}</option>
                  <option value="MANUAL_UPLOAD">{CHANNEL_LABEL.MANUAL_UPLOAD}</option>
                  <option value="OTHER">{CHANNEL_LABEL.OTHER}</option>
                </select>
              </label>
              <div className="inline-fields">
                <label>
                  Număr recipisă
                  <input
                    value={revisalDeliverForm.receiptNumber}
                    onChange={(event) =>
                      setRevisalDeliverForm((prev) => ({
                        ...prev,
                        receiptNumber: event.target.value,
                      }))
                    }
                    placeholder="Obligatoriu pentru WEB_PORTAL"
                  />
                </label>
                <label>
                  Data livrării
                  <input
                    type="datetime-local"
                    value={revisalDeliverForm.deliveredAt}
                    onChange={(event) =>
                      setRevisalDeliverForm((prev) => ({
                        ...prev,
                        deliveredAt: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <button type="submit" disabled={busyKey === 'revisal-deliver'}>
                {busyKey === 'revisal-deliver' ? 'Confirmare...' : 'Marchează ca livrat'}
              </button>
            </form>
          ) : (
            <p className="muted">Nu există exporturi în așteptare pentru livrare.</p>
          )
        ) : (
          <p className="muted">Doar rolurile cu drept de generare salarii pot confirma livrarea.</p>
        )}
        <h3 style={{ marginTop: '1rem' }}>Exporturi Revisal ({revisalExports.length})</h3>
        <label>
          Lista exporturilor Revisal
          <select
            className="accounts-overflow-select"
            size={12}
            value={selectedRevisalExportId}
            onChange={(event) => setSelectedRevisalExportId(event.target.value)}
          >
            <option value="" disabled>
              Selectează exportul
            </option>
            {revisalExports.map((delivery) => (
              <option key={delivery.id} value={delivery.id}>
                {delivery.period} · {delivery.deliveryReference} · {delivery.status}
              </option>
            ))}
          </select>
        </label>
        {selectedRevisalExport ? (
          <div className="timeline-item journal-entry-preview">
            <header>
              <strong>{selectedRevisalExport.period} · {selectedRevisalExport.deliveryReference}</strong>
              <span className={`status status-${selectedRevisalExport.status.toLowerCase()}`}>{selectedRevisalExport.status}</span>
            </header>
            <div className="journal-entry-preview-lines">
              <div>Canal: {selectedRevisalExport.channel ? CHANNEL_LABEL[selectedRevisalExport.channel] : '—'}</div>
              <div>Angajați: {selectedRevisalExport.employeeCount}</div>
              <div>Generat: {toLocalDateTime(selectedRevisalExport.createdAt)}</div>
              <div>Livrat: {toLocalDateTime(selectedRevisalExport.deliveredAt)}</div>
              <div>Checksum: {selectedRevisalExport.xmlChecksum.slice(0, 24)}...</div>
              <div>
                Validare:{' '}
                {selectedRevisalExport.validationPerformed
                  ? selectedRevisalExport.validationPassed
                    ? 'XSD OK'
                    : `XSD NOK (${toCount(selectedRevisalExport.validationErrors)})`
                  : 'XSD N/A'}
                {toCount(selectedRevisalExport.validationWarnings) > 0
                  ? ` | Warn ${toCount(selectedRevisalExport.validationWarnings)}`
                  : ''}
              </div>
            </div>
            <button
              onClick={() => void downloadRevisalXml(selectedRevisalExport)}
              disabled={busyKey === `revisal-download-${selectedRevisalExport.id}`}
            >
              {busyKey === `revisal-download-${selectedRevisalExport.id}` ? 'Descărcare...' : 'XML'}
            </button>
          </div>
        ) : (
          <p className="muted">Selectează un export din listă pentru afișarea în container.</p>
        )}
      </article>
    </section>
  );
}
