import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type User } from "../lib/api";
import { useAuth } from "../lib/auth";
import { browserTimezone, hhmmToMinutes, minutesToHHMM } from "../lib/format";

export function Account() {
  const { user, setUser, logout } = useAuth();
  const nav = useNavigate();
  const [tz, setTz] = useState(user?.timezone ?? "UTC");
  const [quiet, setQuiet] = useState(user?.quiet_hours_start !== null && user?.quiet_hours_end !== null);
  const [qs, setQs] = useState(minutesToHHMM(user?.quiet_hours_start ?? 22 * 60));
  const [qe, setQe] = useState(minutesToHHMM(user?.quiet_hours_end ?? 7 * 60));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  if (!user) return null;

  async function save() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await api.patch<{ user: User }>("/me", {
        timezone: tz,
        quiet_hours_start: quiet ? hhmmToMinutes(qs) : null,
        quiet_hours_end: quiet ? hhmmToMinutes(qe) : null,
      });
      setUser(r.user);
      setMsg("Saved.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.del("/me");
      setUser(null);
      nav("/login", { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't delete the account.");
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Account</h1>

      <label className="lbl">WhatsApp number</label>
      <div className="field" style={{ borderBottomColor: "transparent" }}>
        {user.phone}
        {user.whatsapp_opted_out ? <span className="muted small"> · alerts paused (reply START on WhatsApp to resume)</span> : null}
      </div>

      <label className="lbl" htmlFor="tz">
        Timezone
      </label>
      <div className="field-row">
        <input id="tz" className="field" value={tz} onChange={(e) => setTz(e.target.value)} list="tz-list" autoComplete="off" />
        <button className="btn-text" type="button" onClick={() => setTz(browserTimezone())}>
          use this device's
        </button>
      </div>
      <datalist id="tz-list">
        {["America/Guayaquil", "America/Lima", "America/Bogota", "America/La_Paz", "America/Sao_Paulo", "America/New_York", "America/Los_Angeles", "Europe/Stockholm", "Europe/London", "Australia/Perth", "Australia/Sydney", "UTC"].map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <p className="notice">Daily checks and message times use this.</p>

      <label className="lbl">Quiet hours</label>
      <label className="inline small">
        <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
        <span>Hold alerts overnight and send one summary afterwards</span>
      </label>
      {quiet ? (
        <div className="inline small muted" style={{ marginTop: 8 }}>
          from <input className="field" style={{ width: 80, padding: "4px 0" }} type="time" value={qs} onChange={(e) => setQs(e.target.value)} />
          until <input className="field" style={{ width: 80, padding: "4px 0" }} type="time" value={qe} onChange={(e) => setQe(e.target.value)} />
        </div>
      ) : null}

      <div className="actions">
        <button className="btn" onClick={save} disabled={busy}>
          Save
        </button>
        <button className="btn-text" onClick={() => void logout().then(() => nav("/login", { replace: true }))} disabled={busy}>
          sign out
        </button>
        {msg ? <span className="muted small">{msg}</span> : null}
      </div>
      {error ? <p className="notice error">{error}</p> : null}

      <hr className="hr" />
      {!confirm ? (
        <button className="btn-text danger" onClick={() => setConfirm(true)}>
          delete account
        </button>
      ) : (
        <div className="actions" style={{ marginTop: 0 }}>
          <span className="muted small">This removes your monitors and history. There's no undo.</span>
          <button className="btn-text danger" onClick={remove} disabled={busy}>
            yes, delete everything
          </button>
          <button className="btn-text" onClick={() => setConfirm(false)}>
            keep
          </button>
        </div>
      )}
    </div>
  );
}
