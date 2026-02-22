import type { Dispatch, SetStateAction } from 'react';
import type { Account, JournalEntry } from '../types';

interface JournalFormLine {
  accountId: string;
  debit: string;
  credit: string;
  explanation: string;
}

interface JournalFormState {
  description: string;
  lines: JournalFormLine[];
}

interface JournalPageProps {
  journalForm: JournalFormState;
  setJournalForm: Dispatch<SetStateAction<JournalFormState>>;
  createJournalEntry: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  canCreateJournalEntry: boolean;
  busyKey: string | null;
  accounts: Account[];
  journalEntries: JournalEntry[];
}

export function JournalPage({
  journalForm,
  setJournalForm,
  createJournalEntry,
  canCreateJournalEntry,
  busyKey,
  accounts,
  journalEntries,
}: JournalPageProps) {
  return (
    <section className="split-layout">
      <article className="panel">
        <h3>Notă contabilă (debit/credit)</h3>
        {canCreateJournalEntry ? (
          <form onSubmit={(event) => void createJournalEntry(event)} className="stack-form">
            <label>
              Descriere
              <input
                value={journalForm.description}
                onChange={(event) => setJournalForm((prev) => ({ ...prev, description: event.target.value }))}
                required
              />
            </label>

            <div className="line-editor">
              {journalForm.lines.map((line, index) => (
                <div key={`line-${index}`} className="line-row">
                  <select
                    value={line.accountId}
                    onChange={(event) =>
                      setJournalForm((prev) => {
                        const next = [...prev.lines];
                        next[index] = { ...next[index], accountId: event.target.value };
                        return { ...prev, lines: next };
                      })
                    }
                  >
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} - {account.name}
                      </option>
                    ))}
                  </select>

                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.debit}
                    onChange={(event) =>
                      setJournalForm((prev) => {
                        const next = [...prev.lines];
                        next[index] = { ...next[index], debit: event.target.value };
                        return { ...prev, lines: next };
                      })
                    }
                    placeholder="Debit"
                  />

                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.credit}
                    onChange={(event) =>
                      setJournalForm((prev) => {
                        const next = [...prev.lines];
                        next[index] = { ...next[index], credit: event.target.value };
                        return { ...prev, lines: next };
                      })
                    }
                    placeholder="Credit"
                  />

                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setJournalForm((prev) => ({
                        ...prev,
                        lines: prev.lines.filter((_item, lineIndex) => lineIndex !== index),
                      }))
                    }
                    disabled={journalForm.lines.length <= 2}
                  >
                    Șterge
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              className="ghost"
              onClick={() =>
                setJournalForm((prev) => ({
                  ...prev,
                  lines: [...prev.lines, { accountId: accounts[0]?.id ?? '', debit: '0', credit: '0', explanation: '' }],
                }))
              }
            >
              Adaugă linie
            </button>

            <button type="submit" disabled={busyKey === 'journal'}>
              {busyKey === 'journal' ? 'Salvare...' : 'Salvează draft'}
            </button>
          </form>
        ) : (
          <p className="muted">Ai acces doar de citire pe notele contabile.</p>
        )}
      </article>

      <article className="panel">
        <h3>Ultimele note contabile</h3>
        <div className="timeline">
          {journalEntries.slice(0, 30).map((entry) => (
            <div key={entry.id} className="timeline-item">
              <header>
                <strong>{entry.number ?? 'NC-nealocat'} · {entry.description}</strong>
                <span>{new Date(entry.date).toLocaleDateString('ro-RO')}</span>
              </header>
              <small>Status: {entry.status ?? 'VALIDATED'}</small>
              <small>
                {entry.lines
                  .map((line) => `${line.account.code} D:${Number(line.debit).toFixed(2)} C:${Number(line.credit).toFixed(2)}`)
                  .join(' | ')}
              </small>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
