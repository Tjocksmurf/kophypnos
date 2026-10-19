import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, type Condition, type Interval, type MonitorDetail, type Preview, type Proposal, type Rule } from "../lib/api";
import { IntervalPicker } from "./IntervalPicker";

const PLACEHOLDERS = [
  "tell me when the price drops below $200",
  "when it's back in stock",
  "when a new listing appears",
  "if the headline changes",
  "when the date is announced",
  "if anything on this page changes",
];

type ManualMode = null | "line" | "page";

export function NewMonitor() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const url = params.get("url") ?? "";

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "propose" | "create" | null>(null);

  const [prompt, setPrompt] = useState("");
  const [placeholder, setPlaceholder] = useState(PLACEHOLDERS[0]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualMode>(null);
  const [manualCondition, setManualCondition] = useState<Condition["type"]>("changed");
  const [manualValue, setManualValue] = useState("");

  const [interval, setInterval_] = useState<Interval>("1h");
  const [dailyAt, setDailyAt] = useState(8 * 60);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // rotating placeholder
  useEffect(() => {
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % PLACEHOLDERS.length;
      setPlaceholder(PLACEHOLDERS[i]);
    }, 3500);
    return () => clearInterval(t);
  }, []);

  // step 1: fetch the page
  useEffect(() => {
    if (!url) {
      nav("/", { replace: true });
      return;
    }
    let alive = true;
    setBusy("preview");
    api
      .post<Preview>("/pages/preview", { url })
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setTimeout(() => promptRef.current?.focus(), 50);
      })
      .catch((e) => alive && setPreviewError(e instanceof ApiError ? e.message : "Could not fetch that page."))
      .finally(() => alive && setBusy(null));
    return () => {
      alive = false;
    };
  }, [url, nav]);

  // step 2: propose
  async function propose(e?: FormEvent) {
    e?.preventDefault();
    if (!preview || !prompt.trim()) return;
    setBusy("propose");
    setProposeError(null);
    setProposal(null);
    setManual(null);
    try {
      const p = await api.post<Proposal>("/pages/propose", { preview_id: preview.preview_id, prompt: prompt.trim() });
      setProposal(p);
      if (!p.rule) setProposeError(p.note ?? "Nothing on the page matched that.");
    } catch (err) {
      if (err instanceof ApiError && (err.code === "llm_unavailable" || err.code === "llm_cap")) {
        setProposeError(err.message);
        setManual("line");
      } else {
        setProposeError(err instanceof ApiError ? err.message : "Couldn't work out a rule.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function pickLine(line: string) {
    if (!preview) return;
    setBusy("propose");
    setProposeError(null);
    try {
      const condition: Condition =
        manualCondition === "changed" || manualCondition === "new_item"
          ? { type: manualCondition }
          : manualCondition === "less_than" || manualCondition === "greater_than"
            ? { type: manualCondition, value: Number(manualValue) }
            : { type: manualCondition, value: manualValue };
      const extract = manualCondition === "less_than" || manualCondition === "greater_than" ? "number" : "text";
      const p = await api.post<Proposal>("/pages/manual", { preview_id: preview.preview_id, text: line, condition, extract });
      setProposal(p);
    } catch (err) {
      setProposeError(err instanceof ApiError ? err.message : "Couldn't build that rule.");
    } finally {
      setBusy(null);
    }
  }

  async function pickWholePage() {
    if (!preview) return;
    setBusy("propose");
    setProposeError(null);
    try {
      const p = await api.post<Proposal>("/pages/manual", { preview_id: preview.preview_id, whole_page: true });
      setProposal(p);
      setManual(null);
    } catch (err) {
      setProposeError(err instanceof ApiError ? err.message : "Couldn't build that rule.");
    } finally {
      setBusy(null);
    }
  }

  // step 3: create
  async function create() {
    if (!preview || !proposal?.rule) return;
    setBusy("create");
    try {
      const r = await api.post<{ monitor: MonitorDetail }>("/monitors", {
        preview_id: preview.preview_id,
        rule: proposal.rule,
        interval,
        daily_at: interval === "1d" ? dailyAt : undefined,
        confidence: proposal.confidence,
        created_by: proposal.confidence === 1 && manual !== null ? "user" : "llm",
      });
      nav(`/m/${r.monitor.id}`, { replace: true });
    } catch (err) {
      setProposeError(err instanceof ApiError ? err.message : "Couldn't create the monitor.");
      setBusy(null);
    }
  }

  const rule: Rule | null = proposal?.rule ?? null;
  const highlight = proposal?.highlight ?? null;
  const excerptLines = preview?.excerpt.split("\n") ?? [];

  return (
    <div>
      <h1>New monitor</h1>

      {/* ---- step 1: page ---- */}
      <div className="row" style={{ borderBottom: "1px solid var(--line)" }}>
        {preview?.favicon_url ? <img className="fav" src={preview.favicon_url} alt="" /> : <span className="fav" />}
        <div className="main">
          <div className="title">{preview?.title ?? (busy === "preview" ? "Fetching…" : url)}</div>
          <div className="sub">{url}</div>
        </div>
      </div>
      {previewError ? (
        <div className="step">
          <p className="notice error">{previewError}</p>
          <div className="actions">
            <button className="btn-text" onClick={() => nav("/")}>
              try another URL
            </button>
          </div>
        </div>
      ) : null}
      {preview?.message ? <p className="notice warn">{preview.message}</p> : null}

      {/* ---- step 2: describe ---- */}
      {preview ? (
        <div className="step">
          <form onSubmit={propose}>
            <label className="lbl" htmlFor="prompt">
              What should I watch for?
            </label>
            <div className="field-row">
              <textarea
                id="prompt"
                ref={promptRef}
                className="field"
                rows={1}
                placeholder={placeholder}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void propose();
                  }
                }}
              />
              <button className="btn" type="submit" disabled={busy !== null || !prompt.trim()}>
                {busy === "propose" ? "Thinking…" : rule ? "Try again" : "Suggest a rule"}
              </button>
            </div>
          </form>
          {proposeError ? <p className="notice error">{proposeError}</p> : null}

          <div className="excerpt">
            {excerptLines.map((line, i) => {
              const hl = highlight !== null && line.includes(highlight);
              return (
                <span
                  key={i}
                  className={`line${hl ? " hl" : ""}${manual === "line" ? "" : " static"}`}
                  onClick={() => (manual === "line" ? void pickLine(line) : undefined)}
                  title={manual === "line" ? "Watch this line" : undefined}
                >
                  {line}
                </span>
              );
            })}
            {preview.text_length > preview.excerpt.length ? <span className="line static faint">…</span> : null}
          </div>

          {manual === "line" ? (
            <div className="inline small">
              <span className="muted">Tap a line above to watch it. Alert when it</span>
              <select className="field" style={{ width: "auto" }} value={manualCondition} onChange={(e) => setManualCondition(e.target.value as Condition["type"])}>
                <option value="changed">changes</option>
                <option value="contains">contains…</option>
                <option value="not_contains">no longer contains…</option>
                <option value="less_than">is a number below…</option>
                <option value="greater_than">is a number above…</option>
              </select>
              {manualCondition !== "changed" ? (
                <input className="field" style={{ width: 140 }} placeholder="value" value={manualValue} onChange={(e) => setManualValue(e.target.value)} />
              ) : null}
            </div>
          ) : null}

          <div className="actions small">
            <button className="btn-text" type="button" onClick={() => setManual(manual === "line" ? null : "line")}>
              {manual === "line" ? "done picking" : "pick a line manually"}
            </button>
            <button className="btn-text" type="button" onClick={pickWholePage}>
              watch the whole page
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- step 3: proposal + schedule ---- */}
      {rule ? (
        <div className="step">
          <h2>Rule</h2>
          <p>{proposal?.summary ?? rule.summary}</p>
          {proposal?.observed_value ? (
            <>
              <div className="muted small">Current value</div>
              <div className="value-big">{proposal.observed_value}</div>
            </>
          ) : rule.target.kind !== "page" ? (
            <p className="notice warn">The target could not be read right now. The first check will try again.</p>
          ) : null}
          {proposal && proposal.confidence < 0.6 && proposal.confidence !== 1 ? (
            <p className="notice warn">Not sure this is the right spot. If it isn't, reword or pick a line manually.</p>
          ) : null}
          {proposal?.note && rule ? <p className="notice">{proposal.note}</p> : null}

          <h2>Check</h2>
          <IntervalPicker interval={interval} dailyAt={dailyAt} onChange={(i, d) => { setInterval_(i); setDailyAt(d); }} />

          <div className="actions">
            <button className="btn accent" onClick={create} disabled={busy !== null}>
              {busy === "create" ? "Starting…" : "Start watching"}
            </button>
            <button className="btn-text" onClick={() => nav("/")} disabled={busy !== null}>
              cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
