import type { Dispatch, SetStateAction } from 'react';
import type { Account } from '../types';

interface AccountFormState {
  code: string;
  name: string;
  type: Account['type'];
  currency: string;
}

interface AccountsPageProps {
  accountForm: AccountFormState;
  setAccountForm: Dispatch<SetStateAction<AccountFormState>>;
  createAccount: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canCreateAccount: boolean;
  busyKey: string | null;
  accounts: Account[];
}

export function AccountsPage({
  accountForm,
  setAccountForm,
  createAccount,
  canCreateAccount,
  busyKey,
  accounts,
}: AccountsPageProps) {
  const VISIBLE_ACCOUNTS_LIMIT = 15;
  const visibleAccounts = accounts.slice(0, VISIBLE_ACCOUNTS_LIMIT);
  const remainingAccounts = accounts.slice(VISIBLE_ACCOUNTS_LIMIT);

  return (
    <section className="split-layout">
      <article className="panel">
        <h3>Administrare conturi</h3>
        {canCreateAccount ? (
          <form onSubmit={(event) => void createAccount(event)} className="stack-form">
            <label>
              Cod cont
              <input
                value={accountForm.code}
                onChange={(event) => setAccountForm((prev) => ({ ...prev, code: event.target.value }))}
                required
              />
            </label>
            <label>
              Denumire
              <input
                value={accountForm.name}
                onChange={(event) => setAccountForm((prev) => ({ ...prev, name: event.target.value }))}
                required
              />
            </label>
            <label>
              Tip
              <select
                value={accountForm.type}
                onChange={(event) => setAccountForm((prev) => ({ ...prev, type: event.target.value as Account['type'] }))}
              >
                <option value="ASSET">Activ</option>
                <option value="LIABILITY">Datorie</option>
                <option value="EQUITY">Capital propriu</option>
                <option value="REVENUE">Venit</option>
                <option value="EXPENSE">Cheltuială</option>
              </select>
            </label>
            <button type="submit" disabled={busyKey === 'account'}>
              {busyKey === 'account' ? 'Salvare...' : 'Salvează cont'}
            </button>
          </form>
        ) : (
          <p className="muted">Ai acces doar de citire pe modulul de conturi.</p>
        )}
      </article>

      <article className="panel">
        <h3>Plan de conturi ({accounts.length})</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cod</th>
                <th>Denumire</th>
                <th>Tip</th>
                <th>Monedă</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleAccounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.code}</td>
                  <td>{account.name}</td>
                  <td>{account.type}</td>
                  <td>{account.currency}</td>
                  <td>{account.isActive ? 'Activ' : 'Inactiv'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {remainingAccounts.length > 0 ? (
          <>
            <p className="muted">
              Sunt afișate primele {VISIBLE_ACCOUNTS_LIMIT} conturi. Restul ({remainingAccounts.length}) sunt în lista
              derulantă.
            </p>
            <label>
              Restul conturilor
              <select className="accounts-overflow-select" size={10} defaultValue="">
                <option value="" disabled>
                  Selectează un cont
                </option>
                {remainingAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} - {account.name} ({account.type}, {account.currency},{' '}
                    {account.isActive ? 'Activ' : 'Inactiv'})
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
      </article>
    </section>
  );
}
