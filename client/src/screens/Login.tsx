import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, type User } from "../lib/api";
import { useAuth } from "../lib/auth";
import { browserCountry, browserTimezone } from "../lib/format";

export function Login() {
  const { user, setUser, loading } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") ?? "/";
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loading && user) nav(next, { replace: true });
  }, [user, loading, nav, next]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; dev_code?: string }>("/auth/request-code", {
        phone,
        country: browserCountry(),
        timezone: browserTimezone(),
      });
      setDevCode(r.dev_code ?? null);
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; user: User }>("/auth/verify", { phone, code: value, country: browserCountry() });
      setUser(r.user);
      nav(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setCode("");
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>{step === "phone" ? "Sign in with WhatsApp" : "Enter the code"}</h1>
      {params.get("expired") ? <p className="notice">That link has expired. Sign in to continue.</p> : null}

      {step === "phone" ? (
        <form onSubmit={sendCode}>
          <p className="muted">We'll send a 6-digit code to your WhatsApp. No password needed.</p>
          <label className="lbl" htmlFor="phone">
            Phone number
          </label>
          <div className="field-row">
            <input
              id="phone"
              className="field"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+593 99 123 4567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoFocus
              required
            />
            <button className="btn" type="submit" disabled={busy || phone.replace(/\D/g, "").length < 6}>
              Send code
            </button>
          </div>
          <p className="notice">Login codes and alerts arrive on WhatsApp. Reply STOP any time to pause them.</p>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === 6) void verify(code);
          }}
        >
          <p className="muted">Sent to {phone}.</p>
          <input
            ref={codeRef}
            className="field code-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="••••••"
            value={code}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(v);
              if (v.length === 6) void verify(v);
            }}
            disabled={busy}
          />
          {devCode ? (
            <p className="notice">
              Dev mode, code not sent: <span className="mono">{devCode}</span>
            </p>
          ) : null}
          <div className="actions">
            <button type="button" className="btn-text" onClick={() => setStep("phone")} disabled={busy}>
              change number
            </button>
            <button type="button" className="btn-text" onClick={(e) => void sendCode(e as unknown as FormEvent)} disabled={busy}>
              resend code
            </button>
          </div>
        </form>
      )}
      {error ? <p className="notice error">{error}</p> : null}
    </div>
  );
}
