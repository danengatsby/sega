interface PasswordChangeScreenProps {
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
  busy: boolean;
  error: string;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onConfirmNewPasswordChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onLogout: () => void;
}

export function PasswordChangeScreen(props: PasswordChangeScreenProps) {
  const {
    currentPassword,
    newPassword,
    confirmNewPassword,
    busy,
    error,
    onCurrentPasswordChange,
    onNewPasswordChange,
    onConfirmNewPasswordChange,
    onSubmit,
    onLogout,
  } = props;

  return (
    <main className="login-wrap">
      <section className="login-card">
        <h1>Schimbare Parolă Obligatorie</h1>
        <p>Pentru siguranță, trebuie să îți schimbi parola inițială înainte de acces.</p>
        <form onSubmit={(event) => void onSubmit(event)} className="stack-form">
          <label>
            Parola curentă
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => onCurrentPasswordChange(event.target.value)}
              required
            />
          </label>
          <label>
            Parolă nouă
            <input
              type="password"
              value={newPassword}
              onChange={(event) => onNewPasswordChange(event.target.value)}
              minLength={12}
              required
            />
          </label>
          <label>
            Confirmă parola nouă
            <input
              type="password"
              value={confirmNewPassword}
              onChange={(event) => onConfirmNewPasswordChange(event.target.value)}
              minLength={12}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Actualizare...' : 'Actualizează parola'}
          </button>
        </form>
        <div className="button-row">
          <button className="ghost" onClick={onLogout}>
            Ieșire
          </button>
        </div>
        {error ? <p className="alert">{error}</p> : null}
      </section>
    </main>
  );
}
