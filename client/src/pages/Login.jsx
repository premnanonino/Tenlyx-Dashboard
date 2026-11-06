import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ThemeToggle } from '../lib/theme.jsx';
import { useNow } from '../lib/hooks.js';
import { utcTime } from '../lib/format.js';
import '../styles/login.css';

/** Only same-site paths are allowed as the post-login destination. */
const safeNext = (n) => (n && n.startsWith('/dashboard') ? n : '/dashboard');

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const now = useNow(1000);
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [shake, setShake] = useState(0);
  const [checking, setChecking] = useState(true);
  const [DOMAIN, setDomain] = useState('courserev.ai');
  const emailRef = useRef(null);
  const errRef = useRef(null);

  // Already signed in? Skip the form.
  useEffect(() => {
    api('/auth/me')
      .then((me) => {
        if (me.authenticated) return navigate(next, { replace: true });
        if (me.emailDomain) setDomain(me.emailDomain);
        return setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [navigate, next]);

  useEffect(() => { if (!checking) emailRef.current?.focus(); }, [checking]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    // Check the domain locally first so a typo doesn't use up a login attempt.
    const at = email.trim().toLowerCase().split('@');
    if (at.length !== 2 || !at[0] || at[1] !== DOMAIN) {
      setError(`Use your @${DOMAIN} email address.`);
      setShake((x) => x + 1);
      setTimeout(() => errRef.current?.focus(), 0);
      return;
    }
    setBusy(true); setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      navigate(next, { replace: true });
    } catch (err) {
      setError(
        err.status === 429 ? 'Too many attempts. Wait a minute and try again.'
          : err.status === 401 ? 'Invalid email or password.'
            : err.status === 400 && err.data?.reason === 'domain' ? `Use your @${DOMAIN} email address.`
              : "Couldn't sign in right now. Please try again in a moment.",
      );
      setShake((x) => x + 1);
      setPassword('');
      setTimeout(() => errRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  };

  const capsCheck = (e) => setCaps(e.getModifierState?.('CapsLock') ?? false);

  return (
    <main className="login">
      <a href="#login-form" className="skip">Skip to sign in</a>
      <section className="login__side" aria-hidden>
        <div className="login__side-top">
          <Link to="/" className="mark mark--dark" tabIndex={-1}>TLX/MON</Link>
          <span className="mono">{utcTime(now)} UTC</span>
        </div>
        <div className="login__big">
          <span>Billing</span>
          <span>console<em>.</em></span>
        </div>
        <ul className="login__log mono">
          <li><b>01</b> @{DOMAIN} accounts only</li>
          <li><b>02</b> one shared team password</li>
          <li><b>03</b> session: httponly · samesite strict</li>
          <li><b>04</b> 5 attempts, then throttled</li>
        </ul>
        <div className="login__grid">{Array.from({ length: 96 }, (_, i) => <i key={i} style={{ animationDelay: `${(i * 37) % 1900}ms` }} />)}</div>
      </section>

      <section className="login__main">
        <div className="login__top">
          <Link to="/" className="login__back mono">← Globe</Link>
          <ThemeToggle />
        </div>

        {checking ? (
          <p className="login__checking mono" role="status"><span className="spin-square" /> checking session…</p>
        ) : (
          <form id="login-form" className="login__form" onSubmit={submit} noValidate key={shake}
            data-shake={shake > 0 || undefined} aria-describedby={error ? 'login-error' : undefined}>
            <p className="login__kicker mono"><span>01</span> Restricted</p>
            <h1>Sign in</h1>
            <p className="login__sub">Use your @{DOMAIN} email and the team password.</p>

            {error && (
              <p id="login-error" className="login__error" role="alert" tabIndex={-1} ref={errRef}>{error}</p>
            )}

            <label className="field-l">
              <span>Email</span>
              <input ref={emailRef} type="email" autoComplete="username" inputMode="email" required placeholder={`you@${DOMAIN}`}
                value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} />
            </label>

            <label className="field-l">
              <span>Password</span>
              <span className="field-l__row">
                <input type={show ? 'text' : 'password'} autoComplete="current-password" required
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  onKeyUp={capsCheck} onKeyDown={capsCheck} aria-invalid={!!error}
                  aria-describedby={caps ? 'caps-note' : undefined} />
                <button type="button" className="field-l__show mono" onClick={() => setShow((s) => !s)}
                  aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'}>
                  {show ? 'hide' : 'show'}
                </button>
              </span>
              {caps && <span id="caps-note" className="field-l__caps mono">Caps Lock is on</span>}
            </label>

            <button type="submit" className="login__submit" disabled={busy || !email || !password}>
              <span className="login__submit-fill" aria-hidden />
              <span>{busy ? <><span className="spin-square" /> Verifying</> : 'Sign in'}</span>
              <span aria-hidden>→</span>
            </button>

            <p className="login__foot mono">Don't have the password? Ask your team admin.</p>
          </form>
        )}
      </section>
    </main>
  );
}
