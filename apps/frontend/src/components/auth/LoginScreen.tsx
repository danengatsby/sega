interface LoginHintCredentials {
  label: string;
  email: string;
  password: string;
}

interface LoginScreenProps {
  mode: 'login' | 'register';
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  mfaCode: string;
  mfaRequired: boolean;
  loginHints?: LoginHintCredentials[];
  busy: boolean;
  error: string;
  onModeChange: (mode: 'login' | 'register') => void;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onMfaCodeChange: (value: string) => void;
  onApplyLoginHint?: (hint: LoginHintCredentials) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
}

export function LoginScreen(props: LoginScreenProps) {
  const {
    mode,
    name,
    email,
    password,
    confirmPassword,
    mfaCode,
    mfaRequired,
    loginHints = [],
    busy,
    error,
    onModeChange,
    onNameChange,
    onEmailChange,
    onPasswordChange,
    onConfirmPasswordChange,
    onMfaCodeChange,
    onApplyLoginHint,
    onSubmit,
  } = props;

  return (
    <main className="login-wrap">
      <section className="login-card">
        <h1>SEGA Accounting Suite</h1>
        <p>MVP contabilitate: jurnal dublu, facturi, plăți, rapoarte și audit trail.</p>
        {mode === 'login' && loginHints.length > 0 ? (
          <section className="login-credentials" aria-label="Credențiale de acces">
            <strong>Credențiale rapide</strong>
            {loginHints.map((hint) => (
              <div key={hint.label} className="login-credentials-row">
                <span>{hint.label}</span>
                <code>{hint.email}</code>
                <code>{hint.password}</code>
                {hint.label.toLowerCase().includes('3 firme') ? (
                  <button
                    type="button"
                    className="login-hint-action"
                    onClick={() => onApplyLoginHint?.(hint)}
                    disabled={busy || hint.email === 'n/a' || hint.password === 'n/a'}
                  >
                    Folosește credențialele Contabil 3 firme
                  </button>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
        <div className="auth-mode-switch">
          <button
            type="button"
            className={mode === 'login' ? 'ghost active' : 'ghost'}
            onClick={() => onModeChange('login')}
            disabled={busy}
          >
            Login
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'ghost active' : 'ghost'}
            onClick={() => onModeChange('register')}
            disabled={busy}
          >
            Register
          </button>
        </div>
        <form onSubmit={(event) => void onSubmit(event)} className="stack-form">
          {mode === 'register' ? (
            <label>
              Nume
              <input type="text" value={name} onChange={(event) => onNameChange(event.target.value)} required />
            </label>
          ) : null}
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
          {mode === 'register' ? (
            <label>
              Confirmă parola
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => onConfirmPasswordChange(event.target.value)}
                required
              />
            </label>
          ) : null}
          {mode === 'login' && mfaRequired ? (
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
            {busy ? 'Procesare...' : mode === 'register' ? 'Creează cont' : 'Autentificare'}
          </button>
        </form>
        {mode === 'login' && mfaRequired ? (
          <p className="hint">Contul are MFA activ. Introdu codul din aplicația de autentificare.</p>
        ) : null}
        {error ? <p className="alert">{error}</p> : null}
      </section>
    </main>
  );
}
