import { useMemo, useState } from 'react';
import type { AuditLog } from '../types';

interface AuditPageProps {
  auditLogs: AuditLog[];
}

export function AuditPage({ auditLogs }: AuditPageProps) {
  const [selectedAuditId, setSelectedAuditId] = useState('');
  const selectedAudit = useMemo(() => auditLogs.find((item) => item.id === selectedAuditId) ?? null, [auditLogs, selectedAuditId]);

  return (
    <section className="panel">
      <h3>Audit Trail ({auditLogs.length})</h3>

      <label>
        Linii audit
        <select
          className="accounts-overflow-select"
          size={12}
          value={selectedAuditId}
          onChange={(event) => setSelectedAuditId(event.target.value)}
        >
          <option value="" disabled>
            Selectează o linie de audit
          </option>
          {auditLogs.map((item) => (
            <option key={item.id} value={item.id}>
              {new Date(item.timestamp).toISOString()} · {item.user?.email ?? 'system'} · {item.tableName} · {item.action}
            </option>
          ))}
        </select>
      </label>

      {selectedAudit ? (
        <div className="timeline-item journal-entry-preview">
          <header>
            <strong>
              {selectedAudit.tableName} · {selectedAudit.action}
            </strong>
            <span>{selectedAudit.user?.email ?? 'system'}</span>
          </header>
          <div className="journal-entry-preview-lines">
            <div>Moment UTC: {new Date(selectedAudit.timestamp).toISOString()}</div>
            <div>Motiv: {selectedAudit.reason ?? '-'}</div>
            <div>IP: {selectedAudit.ipAddress ?? '-'}</div>
            <div>User-Agent: {selectedAudit.userAgent ?? '-'}</div>
          </div>
        </div>
      ) : (
        <p className="muted">Selectează o linie de audit din listă pentru afișarea în container.</p>
      )}
    </section>
  );
}
