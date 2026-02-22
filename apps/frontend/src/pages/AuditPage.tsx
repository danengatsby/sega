import type { AuditLog } from '../types';

interface AuditPageProps {
  auditLogs: AuditLog[];
}

export function AuditPage({ auditLogs }: AuditPageProps) {
  return (
    <section className="panel">
      <h3>Jurnal audit ({auditLogs.length})</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Moment UTC</th>
              <th>Utilizator</th>
              <th>Tabelă</th>
              <th>Acțiune</th>
              <th>Motiv</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {auditLogs.map((item) => (
              <tr key={item.id}>
                <td>{new Date(item.timestamp).toISOString()}</td>
                <td>{item.user?.email ?? 'system'}</td>
                <td>{item.tableName}</td>
                <td>{item.action}</td>
                <td>{item.reason ?? '-'}</td>
                <td>{item.ipAddress ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
