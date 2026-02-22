interface LoginScreenProps {
  email: string;
  password: string;
  mfaCode: string;
  mfaRequired: boolean;
  busy: boolean;
  error: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onMfaCodeChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
}

export function LoginScreen(props: LoginScreenProps) {
  const { email, password, mfaCode, mfaRequired, busy, error, onEmailChange, onPasswordChange, onMfaCodeChange, onSubmit } = props;

  return (
    <main className="login-wrap">
      <section className="login-card">
        <h1>SEGA Accounting Suite</h1>
        <p>MVP contabilitate: jurnal dublu, facturi, plăți, rapoarte și audit trail.</p>
        <form onSubmit={(event) => void onSubmit(event)} className="stack-form">
          <label>
            Email
            <input type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} required />
          </label>
          <label>
            Parolă
            <input
              type="password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              required
            />
          </label>
          {mfaRequired ? (
            <label>
              Cod MFA (TOTP)
              <input
                type="text"
                inputMode="numeric"
                value={mfaCode}
                onChange={(event) => onMfaCodeChange(event.target.value)}
                placeholder="000000"
                autoComplete="one-time-code"
                required
              />
            </label>
          ) : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Autentificare...' : 'Autentificare'}
          </button>
        </form>
        {mfaRequired ? <p className="hint">Contul are MFA activ. Introdu codul din aplicația de autentificare.</p> : null}
        {error ? <p className="alert">{error}</p> : null}
      </section>
    </main>
  );
}
