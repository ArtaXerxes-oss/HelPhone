import { useState } from "react";
import { STROOPS, formatStroops, disbursementUsage } from "../lib/treasury";

const card = {
  background: "#1c2c24",
  borderRadius: "16px",
  border: "1px solid rgba(255,255,255,0.08)",
  padding: "20px",
  marginBottom: "12px",
  color: "#F2ECDC",
};
const muted = { color: "rgba(242,236,220,0.5)", fontSize: "12px" };

function shortAddr(a) {
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

/** Real-time multi-asset treasury reserves with daily disbursement usage. */
export function TreasuryPanel({ rows, loading = false }) {
  return (
    <section aria-label="Treasury reserves" style={card}>
      <h2 style={{ margin: "0 0 12px", fontSize: "16px" }}>Treasury reserves</h2>
      {loading && rows.length === 0 ? (
        <p style={muted} role="status">Loading treasury…</p>
      ) : rows.length === 0 ? (
        <p style={muted}>No treasury assets yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((row) => {
            const usage = disbursementUsage(row.dailyLimit, row.spentToday);
            return (
              <li key={row.asset} data-testid="treasury-row" style={{ marginBottom: "14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong title={row.asset}>{shortAddr(row.asset)}</strong>
                  <span>{formatStroops(row.reserve)}</span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`Daily disbursement used for ${shortAddr(row.asset)}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={usage.pct}
                  style={{ height: "6px", background: "rgba(255,255,255,0.1)", borderRadius: "3px", margin: "6px 0" }}
                >
                  <div
                    style={{
                      width: `${usage.pct}%`,
                      height: "100%",
                      borderRadius: "3px",
                      background: usage.exhausted ? "#FF7A6B" : "#3F8487",
                    }}
                  />
                </div>
                <div style={muted}>
                  {usage.unlimited
                    ? "No daily cap"
                    : `${formatStroops(row.spentToday)} / ${formatStroops(row.dailyLimit)} today`}
                  {usage.exhausted && " · daily limit reached"}
                  {row.targetWeightBps > 0 && ` · target ${(row.targetWeightBps / 100).toFixed(1)}%`}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Oracle-backed conversion quote (e.g. XLM -> USDC). */
export function OracleQuoteForm({ getQuote }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setResult(null);
    setError("");
    const units = Math.round(parseFloat(amount) * STROOPS);
    if (!from.trim() || !to.trim() || !(units > 0)) {
      setError("Enter both token addresses and a positive amount.");
      return;
    }
    setBusy(true);
    try {
      setResult(await getQuote(from.trim(), to.trim(), units));
    } catch (err) {
      setError(err?.message || "Could not fetch a conversion quote.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Oracle conversion quote" style={card}>
      <h2 style={{ margin: "0 0 12px", fontSize: "16px" }}>Live conversion quote</h2>
      <input aria-label="From token" placeholder="From token (C…)" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "100%", marginBottom: "8px" }} />
      <input aria-label="To token" placeholder="To token (C…)" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "100%", marginBottom: "8px" }} />
      <input aria-label="Amount" placeholder="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: "100%", marginBottom: "8px" }} />
      <button type="submit" disabled={busy}>{busy ? "Quoting…" : "Get quote"}</button>
      {result && (
        <p role="status" style={{ marginBottom: 0 }}>
          {formatStroops(result.amountIn)} → <strong>{formatStroops(result.amountOut)}</strong>
        </p>
      )}
      {error && <p role="alert" style={{ color: "#FF7A6B", marginBottom: 0 }}>{error}</p>}
    </form>
  );
}
