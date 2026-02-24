import type {
  AgingReport,
  BalanceSheet,
  FinancialStatements,
  PnLReport,
  TrialBalance,
} from '../types';

interface ReportsPageProps {
  busyKey: string | null;
  downloadFinancialExport: (format: 'pdf' | 'excel' | 'xml') => Promise<void>;
  financialStatements: FinancialStatements | null;
  downloadAnafExport: (type: 'd300' | 'd394' | 'd112' | 'd101' | 'd100' | 'd205' | 'd392' | 'd393' | 'd406') => Promise<void>;
  checkAnafValidation: () => Promise<void>;
  canExportReports: boolean;
  anafInfo: string;
  trialBalance: TrialBalance | null;
  pnl: PnLReport | null;
  balanceSheet: BalanceSheet | null;
  aging: AgingReport | null;
  fmtCurrency: (value: number) => string;
}

export function ReportsPage({
  busyKey,
  downloadFinancialExport,
  financialStatements,
  downloadAnafExport,
  checkAnafValidation,
  canExportReports,
  anafInfo,
  trialBalance,
  pnl,
  balanceSheet,
  aging,
  fmtCurrency,
}: ReportsPageProps) {
  return (
    <section className="panel-grid">
      <article className="panel full-width">
        <h3>Export Situații Financiare</h3>
        <div className="button-row">
          <button onClick={() => void downloadFinancialExport('pdf')} disabled={!canExportReports || busyKey === 'export-pdf'}>
            {busyKey === 'export-pdf' ? 'Generare PDF...' : 'Export PDF'}
          </button>
          <button onClick={() => void downloadFinancialExport('excel')} disabled={!canExportReports || busyKey === 'export-excel'}>
            {busyKey === 'export-excel' ? 'Generare Excel...' : 'Export Excel'}
          </button>
          <button onClick={() => void downloadFinancialExport('xml')} disabled={!canExportReports || busyKey === 'export-xml'}>
            {busyKey === 'export-xml' ? 'Generare XML...' : 'Export XML'}
          </button>
        </div>
        {!canExportReports ? <p className="muted">Ai acces doar de citire pe rapoarte.</p> : null}
        <p className="muted">
          Ultima generare: {financialStatements?.meta.generatedAt ?? 'N/A'} | Perioadă: {financialStatements?.meta.from ?? 'N/A'} -{' '}
          {financialStatements?.meta.to ?? 'N/A'}
        </p>
      </article>

      <article className="panel full-width">
        <h3>Export Declarații ANAF (XML)</h3>
        <div className="button-row">
          <button onClick={() => void downloadAnafExport('d300')} disabled={!canExportReports || busyKey === 'export-d300'}>
            {busyKey === 'export-d300' ? 'Generare D300...' : 'Export D300'}
          </button>
          <button onClick={() => void downloadAnafExport('d394')} disabled={!canExportReports || busyKey === 'export-d394'}>
            {busyKey === 'export-d394' ? 'Generare D394...' : 'Export D394'}
          </button>
          <button onClick={() => void downloadAnafExport('d112')} disabled={!canExportReports || busyKey === 'export-d112'}>
            {busyKey === 'export-d112' ? 'Generare D112...' : 'Export D112'}
          </button>
          <button onClick={() => void downloadAnafExport('d101')} disabled={!canExportReports || busyKey === 'export-d101'}>
            {busyKey === 'export-d101' ? 'Generare D101...' : 'Export D101'}
          </button>
          <button onClick={() => void downloadAnafExport('d100')} disabled={!canExportReports || busyKey === 'export-d100'}>
            {busyKey === 'export-d100' ? 'Generare D100...' : 'Export D100'}
          </button>
          <button onClick={() => void downloadAnafExport('d205')} disabled={!canExportReports || busyKey === 'export-d205'}>
            {busyKey === 'export-d205' ? 'Generare D205...' : 'Export D205'}
          </button>
          <button onClick={() => void downloadAnafExport('d392')} disabled={!canExportReports || busyKey === 'export-d392'}>
            {busyKey === 'export-d392' ? 'Generare D392...' : 'Export D392'}
          </button>
          <button onClick={() => void downloadAnafExport('d393')} disabled={!canExportReports || busyKey === 'export-d393'}>
            {busyKey === 'export-d393' ? 'Generare D393...' : 'Export D393'}
          </button>
          <button onClick={() => void downloadAnafExport('d406')} disabled={!canExportReports || busyKey === 'export-d406'}>
            {busyKey === 'export-d406' ? 'Generare D406...' : 'Export D406 / SAF-T'}
          </button>
          <button onClick={() => void checkAnafValidation()} disabled={!canExportReports || busyKey === 'export-anaf-check'}>
            {busyKey === 'export-anaf-check' ? 'Verificare...' : 'Verifică validare ANAF'}
          </button>
        </div>
        <p className="muted">Fișierele sunt generate pentru perioada activă, în format XML gata pentru mapare la fluxurile ANAF.</p>
        {anafInfo ? <p className="muted">{anafInfo}</p> : null}
      </article>

      <article className="panel">
        <h3>Balanță de verificare</h3>
        <div className="metric-row">
          <span>Total debit</span>
          <strong>{fmtCurrency(trialBalance?.totals.debit ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>Total credit</span>
          <strong>{fmtCurrency(trialBalance?.totals.credit ?? 0)}</strong>
        </div>
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
        <div className="metric-row">
          <span>Rezultat net</span>
          <strong>{fmtCurrency(pnl?.netProfit ?? 0)}</strong>
        </div>
      </article>

      <article className="panel">
        <h3>Bilanț</h3>
        <div className="metric-row">
          <span>Active</span>
          <strong>{fmtCurrency(balanceSheet?.assets ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>Datorii</span>
          <strong>{fmtCurrency(balanceSheet?.liabilities ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>Capitaluri</span>
          <strong>{fmtCurrency(balanceSheet?.equity ?? 0)}</strong>
        </div>
      </article>

      <article className="panel">
        <h3>Sumar Fiscal</h3>
        <div className="metric-row">
          <span>TVA colectată</span>
          <strong>{fmtCurrency(financialStatements?.taxSummary.vatCollected ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>CAS + CASS + CAM</span>
          <strong>
            {fmtCurrency(
              (financialStatements?.taxSummary.payrollCas ?? 0) +
                (financialStatements?.taxSummary.payrollCass ?? 0) +
                (financialStatements?.taxSummary.payrollCam ?? 0),
            )}
          </strong>
        </div>
        <div className="metric-row">
          <span>Impozit salarii</span>
          <strong>{fmtCurrency(financialStatements?.taxSummary.payrollTax ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>Impozit profit estimat</span>
          <strong>{fmtCurrency(financialStatements?.taxSummary.estimatedProfitTax ?? 0)}</strong>
        </div>
      </article>

      <article className="panel">
        <h3>Vechime creanțe (Aging)</h3>
        <div className="metric-row">
          <span>Curent</span>
          <strong>{fmtCurrency(aging?.buckets.current ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>1-30 zile</span>
          <strong>{fmtCurrency(aging?.buckets.d1_30 ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>31-60 zile</span>
          <strong>{fmtCurrency(aging?.buckets.d31_60 ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>61-90 zile</span>
          <strong>{fmtCurrency(aging?.buckets.d61_90 ?? 0)}</strong>
        </div>
        <div className="metric-row">
          <span>Peste 90 zile</span>
          <strong>{fmtCurrency(aging?.buckets.d90_plus ?? 0)}</strong>
        </div>
      </article>

      <article className="panel full-width">
        <h3>Detaliu balanță</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cont</th>
                <th>Denumire</th>
                <th>Tip</th>
                <th>Debit</th>
                <th>Credit</th>
              </tr>
            </thead>
            <tbody>
              {(trialBalance?.rows ?? []).map((row) => (
                <tr key={row.accountId}>
                  <td>{row.code}</td>
                  <td>{row.name}</td>
                  <td>{row.type}</td>
                  <td>{fmtCurrency(row.debit)}</td>
                  <td>{fmtCurrency(row.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
