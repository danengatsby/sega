import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { BalanceSheet, DashboardBiAlertItem, DashboardBiReport, PnLReport, PurchasesDashboard } from '../types';

interface DashboardStats {
  openInvoices: number;
  receivables: number;
  journalEntries: number;
  partners: number;
  employees: number;
  assets: number;
}

interface DashboardPageProps {
  stats: DashboardStats;
  pnl: PnLReport | null;
  balanceSheet: BalanceSheet | null;
  dashboardBi: DashboardBiReport | null;
  dashboardBiFilter: {
    asOf: string;
    dueSoonDays: string;
    overdueGraceDays: string;
    minAmount: string;
    maxAlerts: string;
  };
  setDashboardBiFilter: Dispatch<
    SetStateAction<{
      asOf: string;
      dueSoonDays: string;
      overdueGraceDays: string;
      minAmount: string;
      maxAlerts: string;
    }>
  >;
  applyDashboardBiFilter: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  canViewDashboardBi: boolean;
  purchasesDashboard: PurchasesDashboard | null;
  canViewPurchasesDashboard: boolean;
  purchasesDashboardFilter: {
    asOf: string;
    topSuppliers: string;
  };
  setPurchasesDashboardFilter: Dispatch<
    SetStateAction<{
      asOf: string;
      topSuppliers: string;
    }>
  >;
  applyPurchasesDashboardFilter: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  busyKey: string | null;
  fmtCurrency: (value: number) => string;
}

export function DashboardPage({
  stats,
  pnl,
  balanceSheet,
  dashboardBi,
  dashboardBiFilter,
  setDashboardBiFilter,
  applyDashboardBiFilter,
  canViewDashboardBi,
  purchasesDashboard,
  canViewPurchasesDashboard,
  purchasesDashboardFilter,
  setPurchasesDashboardFilter,
  applyPurchasesDashboardFilter,
  busyKey,
  fmtCurrency,
}: DashboardPageProps) {
  const apTotals = purchasesDashboard?.totals;
  const apAsOfLabel = purchasesDashboard?.asOf
    ? new Date(purchasesDashboard.asOf).toLocaleDateString('ro-RO')
    : 'N/A';

  function fmtPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return 'N/A';
    }
    return `${value.toFixed(2)}%`;
  }

  function fmtRatio(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return 'N/A';
    }
    return value.toFixed(2);
  }

  function severityClassName(alert: DashboardBiAlertItem): string {
    if (alert.severity === 'CRITICAL') {
      return 'status status-critical';
    }
    if (alert.severity === 'WARNING') {
      return 'status status-warning';
    }
    return 'status status-info';
  }

  function alertTypeLabel(type: DashboardBiAlertItem['type']): string {
    if (type === 'RECEIVABLE_OVERDUE') {
      return 'AR restantă';
    }
    if (type === 'RECEIVABLE_DUE_SOON') {
      return 'AR scadentă';
    }
    if (type === 'PAYABLE_OVERDUE') {
      return 'AP restantă';
    }
    return 'AP scadentă';
  }

  return (
    <section className="panel-grid">
      <article className="kpi-card">
        <h3>Facturi deschise</h3>
        <p>{stats.openInvoices}</p>
      </article>
      <article className="kpi-card">
        <h3>Creanțe curente</h3>
        <p>{fmtCurrency(stats.receivables)}</p>
      </article>
      <article className="kpi-card">
        <h3>Note contabile</h3>
        <p>{stats.journalEntries}</p>
      </article>
      <article className="kpi-card">
        <h3>Parteneri activi</h3>
        <p>{stats.partners}</p>
      </article>
      <article className="kpi-card">
        <h3>Angajați activi</h3>
        <p>{stats.employees}</p>
      </article>
      <article className="kpi-card">
        <h3>Mijloace fixe</h3>
        <p>{stats.assets}</p>
      </article>
      <article className="kpi-card">
        <h3>Cash disponibil</h3>
        <p>{fmtCurrency(dashboardBi?.kpis.cashPosition ?? 0)}</p>
      </article>
      <article className="kpi-card">
        <h3>Poziție netă AR/AP</h3>
        <p>{fmtCurrency(dashboardBi?.kpis.netOpenPosition ?? 0)}</p>
      </article>
      <article className="kpi-card">
        <h3>Expunere netă restante</h3>
        <p>{fmtCurrency(dashboardBi?.kpis.overdueNetExposure ?? 0)}</p>
      </article>
      <article className="kpi-card">
        <h3>Current ratio</h3>
        <p>{fmtRatio(dashboardBi?.kpis.currentRatio ?? null)}</p>
      </article>
      <article className="kpi-card">
        <h3>Marjă netă YTD</h3>
        <p>{fmtPercent(dashboardBi?.kpis.netProfitMarginPct ?? null)}</p>
      </article>
      <article className="kpi-card">
        <h3>Obligații fiscale</h3>
        <p>{fmtCurrency(dashboardBi?.kpis.totalFiscalLiabilities ?? 0)}</p>
      </article>
      <article className="kpi-card">
        <h3>Datorii furnizori (AP)</h3>
        <p>{fmtCurrency(apTotals?.openAmount ?? 0)}</p>
      </article>
      <article className="kpi-card">
        <h3>Restante furnizori</h3>
        <p>{fmtCurrency(apTotals?.overdueAmount ?? 0)}</p>
      </article>
      <article className="kpi-card">
        <h3>Scadențe AP 7 zile</h3>
        <p>{fmtCurrency(apTotals?.dueNext7DaysAmount ?? 0)}</p>
      </article>

      <article className="panel">
        <h3>Profit și Pierdere</h3>
        <div className="metric-row">
          <span>Venituri</span>
          <strong>{fmtCurrency(pnl?.revenues ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>Cheltuieli</span>
          <strong>{fmtCurrency(pnl?.expenses ?? 0)}</strong>
        </div>
        <div className="metric-row highlight">
          <span>Rezultat net</span>
          <strong>{fmtCurrency(pnl?.netProfit ?? 0)}</strong>
        </div>
      </article>

      <article className="panel">
        <h3>Bilanț Simplificat</h3>
        <div className="metric-row">
          <span>Active</span>
          <strong>{fmtCurrency(balanceSheet?.assets ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>Datorii</span>
          <strong>{fmtCurrency(balanceSheet?.liabilities ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>Capitaluri proprii</span>
          <strong>{fmtCurrency(balanceSheet?.equity ?? 0)}</strong>
        </div>
      </article>

      <article className="panel full-width">
        <h3>Forecast cashflow 30 / 60 / 90 zile</h3>
        {dashboardBi && dashboardBi.forecast.horizons.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Orizont</th>
                  <th>Data țintă</th>
                  <th>Încasări prognozate</th>
                  <th>Plăți prognozate</th>
                  <th>Cashflow net</th>
                  <th>Sold cash proiectat</th>
                  <th># AR</th>
                  <th># AP</th>
                </tr>
              </thead>
              <tbody>
                {dashboardBi.forecast.horizons.map((row) => (
                  <tr key={row.horizonDays}>
                    <td>{row.horizonDays} zile</td>
                    <td>{new Date(row.horizonDate).toLocaleDateString('ro-RO')}</td>
                    <td>{fmtCurrency(row.inflowReceivables)}</td>
                    <td>{fmtCurrency(row.outflowPayables)}</td>
                    <td>{fmtCurrency(row.netCashflow)}</td>
                    <td>{fmtCurrency(row.projectedClosingBalance)}</td>
                    <td>{row.receivablesCount}</td>
                    <td>{row.payablesCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Date insuficiente pentru forecast cashflow.</p>
        )}
      </article>

      <article className="panel full-width">
        <h3>Config alerte BI (scadențe/restanțe)</h3>
        {canViewDashboardBi ? (
          <form className="stack-form" onSubmit={(event) => void applyDashboardBiFilter(event)}>
            <div className="inline-fields">
              <label>
                As of
                <input
                  type="date"
                  value={dashboardBiFilter.asOf}
                  onChange={(event) =>
                    setDashboardBiFilter((prev) => ({
                      ...prev,
                      asOf: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label>
                Zile scadență
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={dashboardBiFilter.dueSoonDays}
                  onChange={(event) =>
                    setDashboardBiFilter((prev) => ({
                      ...prev,
                      dueSoonDays: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label>
                Grace restante (zile)
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={dashboardBiFilter.overdueGraceDays}
                  onChange={(event) =>
                    setDashboardBiFilter((prev) => ({
                      ...prev,
                      overdueGraceDays: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label>
                Sumă minimă alertă
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={dashboardBiFilter.minAmount}
                  onChange={(event) =>
                    setDashboardBiFilter((prev) => ({
                      ...prev,
                      minAmount: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label>
                Max alerte
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={dashboardBiFilter.maxAlerts}
                  onChange={(event) =>
                    setDashboardBiFilter((prev) => ({
                      ...prev,
                      maxAlerts: event.target.value,
                    }))
                  }
                  required
                />
              </label>
            </div>
            <div className="button-row">
              <button type="submit" disabled={busyKey === 'dashboard-bi'}>
                {busyKey === 'dashboard-bi' ? 'Actualizare...' : 'Aplică config BI'}
              </button>
            </div>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a vizualiza dashboard-ul BI.</p>
        )}
        <p className="muted">
          Alerte active: total {dashboardBi?.alerts.summary.total ?? 0}, critice {dashboardBi?.alerts.summary.critical ?? 0},
          warning {dashboardBi?.alerts.summary.warning ?? 0}, info {dashboardBi?.alerts.summary.info ?? 0}
        </p>
      </article>

      <article className="panel full-width">
        <h3>Alerte BI (scadente/restante)</h3>
        {dashboardBi && dashboardBi.alerts.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Severitate</th>
                  <th>Tip</th>
                  <th>Partener</th>
                  <th>Document</th>
                  <th>Scadență</th>
                  <th>Detaliu</th>
                  <th>Suma</th>
                </tr>
              </thead>
              <tbody>
                {dashboardBi.alerts.items.map((alert) => (
                  <tr key={alert.id}>
                    <td>
                      <span className={severityClassName(alert)}>{alert.severity}</span>
                    </td>
                    <td>{alertTypeLabel(alert.type)}</td>
                    <td>{alert.partnerName}</td>
                    <td>{alert.documentNumber}</td>
                    <td>{new Date(alert.dueDate).toLocaleDateString('ro-RO')}</td>
                    <td>
                      {alert.daysOverdue !== null
                        ? `${alert.daysOverdue} zile restante`
                        : `${alert.daysUntilDue ?? 0} zile până la scadență`}
                    </td>
                    <td>{fmtCurrency(alert.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Nu există alerte pentru configurația curentă.</p>
        )}
      </article>

      <article className="panel full-width">
        <h3>Filtru AP Dashboard</h3>
        {canViewPurchasesDashboard ? (
          <form className="stack-form" onSubmit={(event) => void applyPurchasesDashboardFilter(event)}>
            <div className="inline-fields">
              <label>
                As of
                <input
                  type="date"
                  value={purchasesDashboardFilter.asOf}
                  onChange={(event) =>
                    setPurchasesDashboardFilter((prev) => ({
                      ...prev,
                      asOf: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label>
                Top furnizori
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={purchasesDashboardFilter.topSuppliers}
                  onChange={(event) =>
                    setPurchasesDashboardFilter((prev) => ({
                      ...prev,
                      topSuppliers: event.target.value,
                    }))
                  }
                  required
                />
              </label>
            </div>
            <div className="button-row">
              <button type="submit" disabled={busyKey === 'purchases-dashboard'}>
                {busyKey === 'purchases-dashboard' ? 'Actualizare...' : 'Aplică filtru AP'}
              </button>
            </div>
          </form>
        ) : (
          <p className="muted">Nu ai permisiunea de a vizualiza dashboard-ul de achiziții.</p>
        )}
      </article>

      <article className="panel full-width">
        <h3>Top furnizori după sold AP</h3>
        <p className="muted">Snapshot la {apAsOfLabel}</p>
        {canViewPurchasesDashboard && purchasesDashboard && purchasesDashboard.topSuppliers.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Furnizor</th>
                  <th>Facturi deschise</th>
                  <th>Facturi restante</th>
                  <th>Sold deschis</th>
                  <th>Sold restant</th>
                  <th>Scadență minimă</th>
                </tr>
              </thead>
              <tbody>
                {purchasesDashboard.topSuppliers.map((supplier) => (
                  <tr key={supplier.supplierId}>
                    <td>{supplier.supplierName}</td>
                    <td>{supplier.invoicesCount}</td>
                    <td>{supplier.overdueInvoicesCount}</td>
                    <td>{fmtCurrency(supplier.openAmount)}</td>
                    <td>{fmtCurrency(supplier.overdueAmount)}</td>
                    <td>{new Date(supplier.earliestDueDate).toLocaleDateString('ro-RO')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : canViewPurchasesDashboard ? (
          <p className="muted">Nu există facturi furnizor deschise în acest moment.</p>
        ) : (
          <p className="muted">Acces indisponibil fără permisiunea de achiziții.</p>
        )}
      </article>
    </section>
  );
}
