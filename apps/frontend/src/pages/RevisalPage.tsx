import type { Dispatch, SetStateAction } from 'react';
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

  return (
    <section className="split-layout">
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
      </article>

      <article className="panel">
        <h3>Exporturi Revisal ({revisalExports.length})</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Perioadă</th>
                <th>Referință</th>
                <th>Status</th>
                <th>Canal</th>
                <th>Angajați</th>
                <th>Generat</th>
                <th>Livrat</th>
                <th>Validare</th>
                <th>Acțiuni</th>
              </tr>
            </thead>
            <tbody>
              {revisalExports.map((delivery) => {
                const warningCount = toCount(delivery.validationWarnings);
                const errorCount = toCount(delivery.validationErrors);
                const validationLabel = delivery.validationPerformed
                  ? delivery.validationPassed
                    ? 'XSD OK'
                    : `XSD NOK (${errorCount})`
                  : 'XSD N/A';

                return (
                  <tr key={delivery.id}>
                    <td>{delivery.period}</td>
                    <td>
                      <div>{delivery.deliveryReference}</div>
                      <small className="muted">{delivery.xmlChecksum.slice(0, 12)}...</small>
                    </td>
                    <td>
                      <span className={`status status-${delivery.status.toLowerCase()}`}>{delivery.status}</span>
                    </td>
                    <td>{delivery.channel ? CHANNEL_LABEL[delivery.channel] : '—'}</td>
                    <td>{delivery.employeeCount}</td>
                    <td>{toLocalDateTime(delivery.createdAt)}</td>
                    <td>{toLocalDateTime(delivery.deliveredAt)}</td>
                    <td>
                      {validationLabel}
                      {warningCount > 0 ? <small className="muted"> | Warn {warningCount}</small> : null}
                    </td>
                    <td>
                      <button
                        onClick={() => void downloadRevisalXml(delivery)}
                        disabled={busyKey === `revisal-download-${delivery.id}`}
                      >
                        {busyKey === `revisal-download-${delivery.id}` ? 'Descărcare...' : 'XML'}
                      </button>
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
