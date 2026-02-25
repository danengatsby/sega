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
        <label>
          Lista conturilor
          <select className="accounts-overflow-select" size={15} defaultValue="">
            <option value="" disabled>
              Selectează un cont
            </option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} - {account.name} ({account.type}, {account.currency}, {account.isActive ? 'Activ' : 'Inactiv'})
              </option>
            ))}
          </select>
        </label>
      </article>
    </section>
  );
}
