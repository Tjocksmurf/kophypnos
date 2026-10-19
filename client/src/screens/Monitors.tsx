import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type MonitorSummary } from "../lib/api";
import { useAuth } from "../lib/auth";
import { intervalLabel, relativeTime } from "../lib/format";

export function statusDot(m: MonitorSummary): { cls: string; label: string } {
  if (m.status === "paused") return { cls: "quiet", label: "paused" };
  if (m.status === "paused_error") return { cls: "error", label: "paused after errors" };
  if (m.status === "stale") return { cls: "warn", label: "rule may be stale" };
  if (m.last_outcome === "blocked") return { cls: "warn", label: "blocked by the site" };
  if (m.last_outcome === "error") return { cls: "error", label: "last check failed" };
  if (m.last_outcome === "changed") return { cls: "changed", label: "changed" };
  return { cls: "", label: "watching" };
}

export function Monitors() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [url, setUrl] = useState("");
  const [items, setItems] = useState<MonitorSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<{ monitors: MonitorSummary[] }>("/monitors")
        .then((r) => alive && setItems(r.monitors))
        .catch((e) => alive && setError(e.message));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const u = url.trim();
    if (!u) return;
    nav(`/new?url=${encodeURIComponent(u)}`);
  }

  return (
    <div>
      {user?.whatsapp_opted_out ? (
        <div className="banner">Alerts are paused because you replied STOP on WhatsApp. Reply START to resume.</div>
      ) : null}
      <form onSubmit={submit}>
        <div className="field-row">
          <input
            className="field"
            type="url"
            inputMode="url"
            placeholder="Paste a page URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus={items?.length === 0}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn" type="submit" disabled={!url.trim()}>
            Watch
          </button>
        </div>
      </form>

      <div style={{ marginTop: 40 }}>
        {error ? <p className="notice error">{error}</p> : null}
        {items === null ? null : items.length === 0 ? (
          <p className="muted">Paste a URL above to start watching a page.</p>
        ) : (
          <ul className="list">
            {items.map((m) => {
              const d = statusDot(m);
              return (
                <li key={m.id}>
                  <Link to={`/m/${m.id}`} className="row">
                    {m.favicon_url ? <img className="fav" src={m.favicon_url} alt="" loading="lazy" /> : <span className="fav" />}
                    <div className="main">
                      <div className="title">{m.title}</div>
                      <div className="sub">{m.rule_summary ?? intervalLabel(m.interval)}</div>
                    </div>
                    <div className="meta">
                      <span className="when" title={d.label}>
                        {m.last_checked_at ? `checked ${relativeTime(m.last_checked_at)}` : "first check soon"}
                      </span>
                      <span className={`dot ${d.cls}`} title={d.label} />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
