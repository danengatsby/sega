interface MfaSetupPayload {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  accountName: string;
}

interface MfaEnrollmentScreenProps {
  userName: string;
  userEmail: string;
  setupPayload: MfaSetupPayload | null;
  verificationCode: string;
  busy: boolean;
  error: string;
  onGenerateSetup: () => Promise<void>;
  onVerificationCodeChange: (value: string) => void;
  onVerify: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onLogout: () => void;
}

export function MfaEnrollmentScreen(props: MfaEnrollmentScreenProps) {
  const {
    userName,
    userEmail,
    setupPayload,
    verificationCode,
    busy,
    error,
    onGenerateSetup,
    onVerificationCodeChange,
    onVerify,
    onLogout,
  } = props;

  return (
    <main className="login-wrap">
      <section className="login-card">
        <h1>Activare MFA obligatorie</h1>
        <p>
          Utilizator: <strong>{userName}</strong> ({userEmail})
        </p>
        <p>Rolul curent necesită autentificare multi-factor înainte de accesul la modulele operaționale.</p>

        {!setupPayload ? (
          <button type="button" disabled={busy} onClick={() => void onGenerateSetup()}>
            {busy ? 'Se pregătește secretul...' : 'Generează secret MFA'}
          </button>
        ) : (
          <form onSubmit={(event) => void onVerify(event)} className="stack-form">
            <label>
              Cheie secretă (manual entry)
              <input type="text" value={setupPayload.secret} readOnly />
            </label>
            <label>
              URI `otpauth://` (pentru aplicații TOTP)
              <input type="text" value={setupPayload.otpauthUrl} readOnly />
            </label>
            <label>
              Cod de verificare MFA
              <input
                type="text"
                inputMode="numeric"
                value={verificationCode}
                onChange={(event) => onVerificationCodeChange(event.target.value)}
                placeholder="000000"
                autoComplete="one-time-code"
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? 'Validare MFA...' : 'Validează și activează MFA'}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void onGenerateSetup()}>
              Regenerare secret
            </button>
          </form>
        )}

        {error ? <p className="alert">{error}</p> : null}
        <button type="button" className="ghost" disabled={busy} onClick={onLogout}>
          Logout
        </button>
      </section>
    </main>
  );
}
