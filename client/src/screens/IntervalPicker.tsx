import type { Interval } from "../lib/api";
import { hhmmToMinutes, minutesToHHMM } from "../lib/format";

export function IntervalPicker({
  interval,
  dailyAt,
  onChange,
  disabled,
}: {
  interval: Interval;
  dailyAt: number;
  onChange: (interval: Interval, dailyAt: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline">
      <div className="seg" role="radiogroup" aria-label="Check interval">
        {(["30m", "1h", "1d"] as Interval[]).map((i) => (
          <button key={i} type="button" role="radio" aria-checked={interval === i} className={interval === i ? "on" : ""} disabled={disabled} onClick={() => onChange(i, dailyAt)}>
            {i === "30m" ? "30 min" : i === "1h" ? "Hourly" : "Daily"}
          </button>
        ))}
      </div>
      {interval === "1d" ? (
        <label className="inline small muted">
          at
          <input
            className="field"
            style={{ width: 80, padding: "6px 0" }}
            type="time"
            value={minutesToHHMM(dailyAt)}
            disabled={disabled}
            onChange={(e) => {
              const m = hhmmToMinutes(e.target.value);
              if (m !== null) onChange(interval, m);
            }}
          />
        </label>
      ) : null}
    </div>
  );
}
