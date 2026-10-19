import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type Interval, type MonitorDetail as Detail, type Proposal } from "../lib/api";
import { absoluteTime, intervalLabel, relativeTime } from "../lib/format";
import { IntervalPicker } from "./IntervalPicker";
import { statusDot } from "./Monitors";

export function MonitorDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [m, setM] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reproposal, setReproposal] = useState<Proposal | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ monitor: Detail }>(`/monitors/${id}`);
      setM(r.monitor);
      setError(null);
      return r.monitor;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load this monitor.");
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while the first check hasn't happened yet.
  useEffect(() => {
    if (!m || m.last_checked_at) return;
    const t = setInterval(() => void load(), 5000);
    const stop = setTimeout(() => clearInterval(t), 90_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [m, load]);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  if (!m) return error ? <p className="notice error">{error}</p> : null;
  const d = statusDot(m);
  const paused = m.status === "paused" || m.status === "paused_error";

  return (
    <div>
      <div className="row" style={{ borderBottom: "1px solid var(--line)", marginBottom: 24 }}>
        {m.favicon_url ? <img className="fav" src={m.favicon_url} alt="" /> : <span className="fav" />}
        <div className="main">
          <div className="title">
            <a href={m.url} target="_blank" rel="noreferrer noopener">
              {m.title}
            </a>
          </div>
          <div className="sub">{m.host}</div>
        </div>
        <div className="meta">
          <span>{d.label}</span>
          <span className={`dot ${d.cls}`} />
        </div>
      </div>

      {m.status === "stale" ? (
        <div className="banner">
          The page layout changed and the rule may be stale.{" "}
          <button className="btn-text" style={{ color: "inherit", textDecoration: "underline" }} disabled={busy !== null} onClick={() => act("repropose", async () => setReproposal(await api.post<Proposal>(`/monitors/${m.id}/repropose`)))}>
            find it again
          </button>
        </div>
      ) : null}
      {m.status === "paused_error" ? <div className="banner">Paused after repeated errors{m.last_error ? ` (${m.last_error})` : ""}. Resume to try again.</div> : null}
      {m.last_outcome === "blocked" && m.status === "active" ? <div className="banner">The site is blocking automated checks. Checks continue, but may keep failing.</div> : null}

      {reproposal ? (
        <div className="step" style={{ marginTop: 0, marginBottom: 32 }}>
          {reproposal.rule ? (
            <>
              <p>{reproposal.summary}</p>
              {reproposal.observed_value ? <div className="value-big">{reproposal.observed_value}</div> : null}
              <div className="actions">
                <button className="btn accent" disabled={busy !== null} onClick={() => act("apply", async () => { await api.patch(`/monitors/${m.id}`, { rule: reproposal.rule }); setReproposal(null); })}>
                  Use this rule
                </button>
                <button className="btn-text" onClick={() => setReproposal(null)}>
                  cancel
                </button>
              </div>
            </>
          ) : (
            <p className="notice warn">{reproposal.note ?? "Couldn't find it on the current page."}</p>
          )}
        </div>
      ) : null}

      <p className="muted">{m.rule_summary}</p>
      <div className="muted small" style={{ marginTop: 20 }}>
        Current value
      </div>
      <div className="value-big">{m.last_value ?? (m.last_checked_at ? "—" : "Checking…")}</div>
      {m.previous_value !== null ? <div className="value-prev">was {m.previous_value}</div> : <div className="value-prev" />}

      <div className="inline" style={{ marginBottom: 8 }}>
        <IntervalPicker
          interval={m.interval}
          dailyAt={m.daily_at ?? 8 * 60}
          disabled={busy !== null}
          onChange={(i: Interval, dailyAt) => act("interval", () => api.patch(`/monitors/${m.id}`, { interval: i, daily_at: i === "1d" ? dailyAt : null }))}
        />
      </div>
      <p className="small muted">
        {paused ? "Paused" : `Checked ${intervalLabel(m.interval)}`}
        {m.last_checked_at ? ` · last ${relativeTime(m.last_checked_at)}` : ""}
        {m.last_alert_at ? ` · alerted ${relativeTime(m.last_alert_at)}` : ""}
      </p>

      <div className="actions">
        <button className="btn-text" disabled={busy !== null} onClick={() => act("check", () => api.post(`/monitors/${m.id}/check`))}>
          {busy === "check" ? "checking…" : "check now"}
        </button>
        <button className="btn-text" disabled={busy !== null} onClick={() => act("pause", () => api.patch(`/monitors/${m.id}`, { status: paused ? "active" : "paused" }))}>
          {paused ? "resume" : "pause"}
        </button>
        {m.status !== "stale" ? (
          <button className="btn-text" disabled={busy !== null} onClick={() => act("repropose", async () => setReproposal(await api.post<Proposal>(`/monitors/${m.id}/repropose`)))}>
            {busy === "repropose" ? "thinking…" : "edit rule"}
          </button>
        ) : null}
      </div>
      {error ? <p className="notice error">{error}</p> : null}

      <h2>History</h2>
      {m.changes.length === 0 ? (
        <p className="muted">No changes yet.</p>
      ) : (
        <div>
          {m.changes.map((c) => (
            <div className="change-row" key={c.id}>
              <div className="when">
                {absoluteTime(c.created_at)}
                {c.alerted ? " · sent to WhatsApp" : ""}
              </div>
              <div className="vals">
                {c.old_value !== null && c.old_value !== c.new_value ? (
                  <>
                    <span className="old">{c.old_value}</span> <span className="faint">→</span>{" "}
                  </>
                ) : null}
                {c.new_value ?? c.summary}
              </div>
              {c.summary && c.summary !== c.new_value && c.old_value !== null ? <div className="small muted">{c.summary}</div> : null}
            </div>
          ))}
        </div>
      )}

      <hr className="hr" />
      {!confirmDelete ? (
        <button className="btn-text danger" onClick={() => setConfirmDelete(true)}>
          delete this monitor
        </button>
      ) : (
        <div className="actions" style={{ marginTop: 0 }}>
          <span className="muted small">Delete this monitor and its history?</span>
          <button className="btn-text danger" disabled={busy !== null} onClick={() => act("delete", async () => { await api.del(`/monitors/${m.id}`); nav("/", { replace: true }); })}>
            yes, delete
          </button>
          <button className="btn-text" onClick={() => setConfirmDelete(false)}>
            keep
          </button>
        </div>
      )}
    </div>
  );
}
