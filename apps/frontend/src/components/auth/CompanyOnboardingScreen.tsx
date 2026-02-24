import type { AvailableCompany } from '../../types';

interface CompanyOnboardingScreenProps {
  userName: string;
  availableCompanies: AvailableCompany[];
  companyCode: string;
  companyName: string;
  busy: boolean;
  error: string;
  onCompanyCodeChange: (value: string) => void;
  onCompanyNameChange: (value: string) => void;
  onCreateCompany: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onSelectCompany: (companyId: string) => void;
  onLogout: () => void;
}

export function CompanyOnboardingScreen(props: CompanyOnboardingScreenProps) {
  const {
    userName,
    availableCompanies,
    companyCode,
    companyName,
    busy,
    error,
    onCompanyCodeChange,
    onCompanyNameChange,
    onCreateCompany,
    onSelectCompany,
    onLogout,
  } = props;

  return (
    <main className="login-wrap">
      <section className="login-card">
        <h1>Bine ai venit, {userName}</h1>
        <p>Selectează compania în care vrei să lucrezi sau creează una nouă.</p>

        {availableCompanies.length > 0 ? (
          <div className="stack-form">
            <label>
              Companii disponibile
              <select
                defaultValue=""
                onChange={(event) => {
                  const selectedCompanyId = event.target.value;
                  if (selectedCompanyId) {
                    onSelectCompany(selectedCompanyId);
                  }
                }}
                disabled={busy}
              >
                <option value="" disabled>
                  Selectează compania
                </option>
                {availableCompanies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name} ({company.code})
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <p className="muted">Nu există încă firme asociate contului.</p>
        )}

        <form onSubmit={(event) => void onCreateCompany(event)} className="stack-form">
          <label>
            Cod companie
            <input
              type="text"
              value={companyCode}
              onChange={(event) => onCompanyCodeChange(event.target.value)}
              placeholder="SEGA01"
              required
            />
          </label>
          <label>
            Nume companie
            <input
              type="text"
              value={companyName}
              onChange={(event) => onCompanyNameChange(event.target.value)}
              placeholder="SEGA SRL"
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Procesare...' : 'Creează companie'}
          </button>
        </form>

        <button type="button" className="ghost" onClick={onLogout} disabled={busy}>
          Ieșire
        </button>
        {error ? <p className="alert">{error}</p> : null}
      </section>
    </main>
  );
}
