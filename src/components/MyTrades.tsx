import React, { useEffect, useMemo, useState } from "react";

export interface JournalTrade {
  id: string;
  symbol: string;
  name?: string;
  strategyId?: string;
  strategyLabel?: string;
  module?: string;
  takenAt: string;
  entryDate: string;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  status: "OPEN" | "SL_HIT" | "TARGET_HIT" | "CLOSED_MANUAL";
  exitPrice?: number;
  exitDate?: string;
  returnPct?: number;
  currentPrice?: number;
  unrealizedPct?: number;
  depthPct?: number;
  durationM?: number;
  note?: string;
  aiReview?: string;
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  OPEN: { label: "OPEN", color: "#fbbf24", bg: "rgba(251,191,36,0.12)" },
  PENDING: { label: "PENDING ⏳", color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
  TARGET_HIT: { label: "TARGET HIT ✓", color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
  SL_HIT: { label: "SL HIT ✗", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  CLOSED_MANUAL: { label: "MANUAL EXIT", color: "#60a5fa", bg: "rgba(59,130,246,0.12)" }
};

const box: React.CSSProperties = { padding: "12px 14px", borderRadius: "10px", background: "#0f141c", border: "1px solid #212836", marginBottom: "14px" };
const th: React.CSSProperties = { padding: "6px 10px", textAlign: "left", color: "#8e9ba9", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em" };
const td: React.CSSProperties = { padding: "7px 10px", fontFamily: "monospace", fontSize: "12.5px", borderTop: "1px solid #1b2230" };
const btn: React.CSSProperties = { background: "#151b27", border: "1px solid #2a3342", color: "#c9d3df", borderRadius: "6px", padding: "3px 9px", fontSize: "11px", cursor: "pointer", fontFamily: "monospace" };

export function MyTrades({ onCountChange, mode = "live", asOfDate }: { onCountChange?: (n: number) => void; mode?: "live" | "playback"; asOfDate?: string; key?: string }) {
  const isPb = mode === "playback";
  const base = isPb ? "/api/playback/trades" : "/api/trades";
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState("");
  const [overallReview, setOverallReview] = useState("");
  const [reviewing, setReviewing] = useState<string | null>(null); // trade id or "ALL"
  const [expandedReview, setExpandedReview] = useState<string | null>(null);
  const [exitSignals, setExitSignals] = useState<Record<string, { signal: boolean; reason: string }>>({});

  const setAll = (list: JournalTrade[]) => {
    setTrades(list);
    if (onCountChange) onCountChange(list.length);
  };

  const fetchExitSignals = async () => {
    if (isPb) return; // playback me live signals nahi check karte
    try {
      const r = await fetch("/api/trades/exit-signals");
      const d = await r.json();
      if (d.ok) setExitSignals(d.signals || {});
    } catch { /* best-effort */ }
  };

  const load = async () => {
    try {
      const r = await fetch(`${base}?t=${Date.now()}${isPb && asOfDate ? `&asOf=${asOfDate}` : ""}`);
      const d = await r.json();
      setAll(Array.isArray(d.trades) ? d.trades : []);
      if (!isPb) fetchExitSignals();
    } catch {
      setMsg("❌ Journal load nahi hua — server chal raha hai?");
    } finally {
      setLoading(false);
    }
  };

  const checkPrices = async (silent = false) => {
    setChecking(true);
    if (!silent) setMsg("🔄 Fresh prices se SL/target check ho raha hai…");
    try {
      const r = await fetch(`${base}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isPb ? { asOfDate } : {})
      });
      const d = await r.json();
      if (d.ok) {
        setAll(Array.isArray(d.trades) ? d.trades : []);
        const fail = d.failedSymbols?.length ? ` (${d.failedSymbols.join(", ")} ka data nahi mila)` : "";
        setMsg(d.updated > 0 ? `✅ ${d.updated} trade(s) close hue is check mein${fail}` : silent ? "" : `✅ Prices updated — koi SL/target hit nahi hua${fail}`);
      }
    } catch {
      setMsg("❌ Price check fail — network dekho");
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    // auto-check on open; in playback, RE-check every time the virtual date moves
    load().then(() => checkPrices(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPb ? asOfDate : "live"]);

  const manualClose = async (t: JournalTrade) => {
    if (isPb) {
      if (!window.confirm(`${t.symbol} — ${asOfDate} ke CLOSE price pe exit karein? (real jaisa: price cherry-pick nahi kar sakte)`)) return;
      const r = await fetch(`${base}/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: t.id, asOfDate }) });
      const d = await r.json();
      if (d.ok) { setMsg(`✅ ${t.symbol} closed @ ₹${d.trade.exitPrice} (${asOfDate} close)`); load(); } else setMsg(`❌ ${d.error}`);
      return;
    }
    const input = window.prompt(`${t.symbol} — kis price pe exit kiya? (entry ₹${t.entryPrice})`, String(t.currentPrice ?? t.entryPrice));
    if (input === null) return;
    const px = Number(input);
    if (!isFinite(px) || px <= 0) { setMsg("❌ Valid price daalo"); return; }
    const r = await fetch(`${base}/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: t.id, exitPrice: px }) });
    const d = await r.json();
    if (d.ok) { setMsg(`✅ ${t.symbol} manually closed @ ₹${px}`); load(); } else setMsg(`❌ ${d.error}`);
  };

  const remove = async (t: JournalTrade) => {
    if (!window.confirm(`${t.symbol} ka journal entry delete karein? Ye wapas nahi aayega.`)) return;
    const r = await fetch(`${base}/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: t.id }) });
    const d = await r.json();
    if (d.ok) load(); else setMsg(`❌ ${d.error}`);
  };

  const aiReview = async (id?: string) => {
    setReviewing(id || "ALL");
    try {
      const r = await fetch("/api/trades/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(id ? { id } : {}), ...(isPb ? { journal: "playback" } : {}) }) });
      const d = await r.json();
      if (d.ok) {
        if (id) { await load(); setExpandedReview(id); }
        else setOverallReview(d.review);
      } else setMsg(`⚠️ ${d.error}`);
    } catch {
      setMsg("❌ AI review request fail");
    } finally {
      setReviewing(null);
    }
  };

  const open = trades.filter((t) => t.status === "OPEN" || (t.status as string) === "PENDING");
  // FIX: PENDING ko closed list se exclude karo — pehle ye dono tables mein dikhta tha
  // aur closed table uske null returnPct pe crash karti thi (black screen).
  const closed = trades.filter((t) => t.status !== "OPEN" && (t.status as string) !== "PENDING").sort((a, b) => (b.exitDate || "").localeCompare(a.exitDate || ""));

  // ---------- Stats-based learning insights (client-side, no AI needed) ----------
  const stats = useMemo(() => {
    if (closed.length === 0) return null;
    const wins = closed.filter((t) => (t.returnPct ?? 0) > 0);
    const losses = closed.filter((t) => (t.returnPct ?? 0) <= 0);
    const avg = (arr: JournalTrade[]) => (arr.length ? arr.reduce((s, t) => s + (t.returnPct ?? 0), 0) / arr.length : 0);
    const byStrat: Record<string, { n: number; w: number; sum: number }> = {};
    for (const t of closed) {
      const k = t.strategyLabel || t.module || "Unknown";
      byStrat[k] = byStrat[k] || { n: 0, w: 0, sum: 0 };
      byStrat[k].n++;
      if ((t.returnPct ?? 0) > 0) byStrat[k].w++;
      byStrat[k].sum += t.returnPct ?? 0;
    }
    const holdDays = (t: JournalTrade) => Math.max(1, Math.round((new Date(t.exitDate || t.entryDate).getTime() - new Date(t.entryDate).getTime()) / 86400000));
    const winRate = Math.round((100 * wins.length) / closed.length);
    const avgWin = avg(wins);
    const avgLoss = avg(losses);
    const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;
    const insights: string[] = [];
    // Rule-based lessons from the user's OWN data
    const slHits = closed.filter((t) => t.status === "SL_HIT");
    if (slHits.length >= 2) {
      const deepSl = slHits.filter((t) => (t.depthPct ?? 0) >= 26).length;
      if (deepSl / slHits.length >= 0.6) insights.push(`⚠️ Tumhare ${slHits.length} mein se ${deepSl} SL hits DEEP base (26%+) cups mein hue — shallow bases (12-19%) prefer karo.`);
    }
    const manualLosses = closed.filter((t) => t.status === "CLOSED_MANUAL" && (t.returnPct ?? 0) < 0);
    if (manualLosses.length >= 2) insights.push(`⚠️ ${manualLosses.length} manual exits loss mein hue — plan se pehle exit karna pattern ban raha hai. SL pe bharosa rakho.`);
    if (avgLoss !== 0 && Math.abs(avgLoss) > avgWin && wins.length && losses.length) insights.push(`⚠️ Average loss (${avgLoss.toFixed(1)}%) average win (${avgWin.toFixed(1)}%) se bada hai — risk:reward ulta chal raha hai.`);
    if (expectancy > 0) insights.push(`✅ Expectancy +${expectancy.toFixed(2)}%/trade — system positive edge dikha raha hai, discipline maintain rakho.`);
    return { winRate, wins: wins.length, losses: losses.length, avgWin, avgLoss, expectancy, byStrat, avgHold: Math.round(closed.reduce((s, t) => s + holdDays(t), 0) / closed.length), insights };
  }, [closed]);

  // FIX: null-safe formatter — server PENDING trades ke liye null bhejta hai (undefined nahi);
  // pehle null.toFixed(2) crash karta tha → black screen. Ab null/NaN sab pe "—".
  const fmtPct = (v?: number | null) => (v === undefined || v === null || !isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

  if (loading) return <div className="state"><div className="spinner" />Journal load ho raha hai…</div>;

  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "12px" }}>
        <button className="toggle-filter-btn" onClick={() => checkPrices(false)} disabled={checking} style={{ opacity: checking ? 0.6 : 1 }}>
          {checking ? "⏳ Checking…" : "🔄 Check SL / Target now"}
        </button>
        {!isPb && (
          <button className="toggle-filter-btn" onClick={fetchExitSignals} style={{ marginLeft: "8px" }}>
            🔔 Refresh Exit Signals
          </button>
        )}
        {isPb && (
          <button
            className="toggle-filter-btn"
            onClick={async () => {
              if (!window.confirm("Pura practice journal reset karein? (real journal safe rahega)")) return;
              await fetch("/api/playback/trades/reset", { method: "POST" });
              load();
            }}
          >
            🗑 Reset practice journal
          </button>
        )}
        {closed.length > 0 && (
          <button className="toggle-filter-btn" onClick={() => aiReview()} disabled={reviewing !== null}>
            {reviewing === "ALL" ? "⏳ Gemini soch raha hai…" : "🧠 AI Review (pura journal)"}
          </button>
        )}
        {msg && <span style={{ fontSize: "12px", color: "#8e9ba9", fontFamily: "monospace" }}>{msg}</span>}
      </div>

      {trades.length === 0 && (
        <div style={{ ...box, textAlign: "center", padding: "40px 20px", color: "#8e9ba9" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "#e6edf5", marginBottom: "6px" }}>{isPb ? "Practice journal khali hai" : "Abhi koi trade journal mein nahi hai"}</div>
          {isPb
            ? <>Playback date pe kisi LIVE row ko expand karke <strong style={{ color: "#c084fc" }}>"✋ Take this trade (practice)"</strong> dabao — phir din aage badhao aur dekho SL hit hota hai ya target.</>
            : <>Kisi bhi module mein stock row expand karo aur <strong style={{ color: "#fbbf24" }}>"✋ Take this trade"</strong> dabao — entry, SL aur target yahan track honge.</>}
        </div>
      )}

      {open.length > 0 && (
        <div style={box}>
          <h4 style={{ margin: "0 0 8px", color: "#fbbf24" }}>🟡 {isPb ? "Open Practice Trades" : "Open Trades"} ({open.length})</h4>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Stock</th><th style={th}>Strategy</th><th style={th}>Entry Date</th><th style={th}>Entry ₹</th>
                <th style={th}>SL ₹</th><th style={th}>Target ₹</th><th style={th}>Now ₹</th><th style={th}>Unrealized</th><th style={th}>Actions</th>
              </tr></thead>
              <tbody>
                {open.map((t) => (
                  <tr key={t.id}>
                    <td style={td}>
                      <strong>{t.symbol.replace(".NS", "")}</strong>
                      {(t.status as string) === "PENDING" && <span style={{ marginLeft: "6px", fontSize: "10px", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.4)", borderRadius: "4px", padding: "1px 5px" }}>PENDING</span>}
                      {/* Exit signal badge */}
                      {exitSignals[t.id] && (
                        <div style={{
                          marginTop: "4px", fontSize: "10.5px", fontFamily: "monospace",
                          color: exitSignals[t.id].signal ? "#fbbf24" : "#22c55e",
                          background: exitSignals[t.id].signal ? "rgba(251,191,36,0.10)" : "rgba(34,197,94,0.08)",
                          border: `1px solid ${exitSignals[t.id].signal ? "rgba(251,191,36,0.4)" : "rgba(34,197,94,0.25)"}`,
                          borderRadius: "5px", padding: "2px 6px", lineHeight: "1.5"
                        }}>
                          {exitSignals[t.id].reason}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, fontFamily: "inherit", fontSize: "11.5px", color: "#8e9ba9" }}>{t.strategyLabel || "—"}</td>
                    <td style={td}>{(t.status as string) === "PENDING" ? "agla session" : t.entryDate}</td>
                    <td style={td}>{t.entryPrice ?? "—"}</td>
                    <td style={{ ...td, color: "#ef4444" }}>{t.stopPrice ?? "—"}</td>
                    <td style={{ ...td, color: "#22c55e" }}>{t.targetPrice ?? "—"}</td>
                    <td style={td}>{t.currentPrice ?? "—"}</td>
                    <td style={{ ...td, color: (t.unrealizedPct ?? 0) >= 0 ? "#22c55e" : "#ef4444" }}>{fmtPct(t.unrealizedPct)}</td>
                    <td style={td}>
                      {(t.status as string) !== "PENDING" && <><button style={btn} onClick={() => manualClose(t)}>{isPb ? "Exit @ day close" : "Exit manually"}</button>{" "}</>}
                      <button style={{ ...btn, color: "#ef4444" }} onClick={() => remove(t)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: "11px", color: "#576575", marginTop: "8px", fontFamily: "monospace" }}>
            {isPb
              ? "SL/target sirf playback date TAK ke historical candles se resolve hote hain — future ka koi data leak nahi. Din aage badhao, trades khud update honge."
              : 'SL/target roz ke daily candles se check hota hai (gap-aware). "Check SL / Target now" dabao ya tab dobara kholo — auto-update ho jata hai.'}
          </div>
        </div>
      )}

      {stats && (
        <div style={box}>
          <h4 style={{ margin: "0 0 8px", color: "#60a5fa" }}>📊 Tumhara Scorecard (closed trades se)</h4>
          <div style={{ fontFamily: "monospace", fontSize: "13px", color: "#c9d3df", marginBottom: "8px" }}>
            <strong>{closed.length}</strong> closed · <span style={{ color: "#22c55e" }}>{stats.wins} win</span> / <span style={{ color: "#ef4444" }}>{stats.losses} loss</span> · <strong>{stats.winRate}%</strong> win rate
            {" · "}Avg win <span style={{ color: "#22c55e" }}>+{stats.avgWin.toFixed(1)}%</span> · Avg loss <span style={{ color: "#ef4444" }}>{stats.avgLoss.toFixed(1)}%</span>
            {" · "}Expectancy <strong style={{ color: stats.expectancy >= 0 ? "#22c55e" : "#ef4444" }}>{stats.expectancy >= 0 ? "+" : ""}{stats.expectancy.toFixed(2)}%/trade</strong> · Avg hold {stats.avgHold}d
          </div>
          <div style={{ fontFamily: "monospace", fontSize: "12px", color: "#8e9ba9", marginBottom: stats.insights.length ? "8px" : 0 }}>
            {(Object.entries(stats.byStrat) as [string, { n: number; w: number; sum: number }][]).map(([k, v]) => (
              <div key={k}>· {k}: {v.n} trades, {Math.round((100 * v.w) / v.n)}% win, net {v.sum >= 0 ? "+" : ""}{v.sum.toFixed(1)}%</div>
            ))}
          </div>
          {stats.insights.map((line, i) => (
            <div key={i} style={{ fontSize: "12.5px", padding: "6px 10px", borderRadius: "6px", background: line.startsWith("✅") ? "rgba(34,197,94,0.08)" : "rgba(245,158,11,0.08)", border: `1px solid ${line.startsWith("✅") ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)"}`, marginTop: "6px", color: "#c9d3df" }}>
              {line}
            </div>
          ))}
        </div>
      )}

      {overallReview && (
        <div style={{ ...box, borderColor: "rgba(168,85,247,0.4)", background: "rgba(168,85,247,0.06)" }}>
          <h4 style={{ margin: "0 0 8px", color: "#c084fc" }}>🧠 Gemini Coach Review</h4>
          <div style={{ fontSize: "13px", color: "#e2d9f3", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{overallReview}</div>
        </div>
      )}

      {closed.length > 0 && (
        <div style={box}>
          <h4 style={{ margin: "0 0 8px", color: "#8e9ba9" }}>📁 Closed Trades ({closed.length})</h4>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Stock</th><th style={th}>Entry → Exit</th><th style={th}>Entry ₹</th><th style={th}>Exit ₹</th>
                <th style={th}>Return</th><th style={th}>Result</th><th style={th}>Review</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {closed.map((t) => {
                  {/* FIX: unknown status kabhi black-screen na kare — safe fallback badge */}
                  const m = STATUS_META[t.status] || { label: String(t.status), color: "#8e9ba9", bg: "rgba(142,155,169,0.12)" };
                  return (
                    <React.Fragment key={t.id}>
                      <tr>
                        <td style={td}><strong>{t.symbol.replace(".NS", "")}</strong><div style={{ fontSize: "10.5px", color: "#576575" }}>{t.strategyLabel || ""}</div></td>
                        <td style={td}>{t.entryDate} → {t.exitDate}</td>
                        <td style={td}>{t.entryPrice}</td>
                        <td style={td}>{t.exitPrice}</td>
                        <td style={{ ...td, color: (t.returnPct ?? 0) >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{fmtPct(t.returnPct)}</td>
                        <td style={td}><span style={{ fontSize: "10.5px", padding: "2px 7px", borderRadius: "4px", color: m.color, background: m.bg, border: `1px solid ${m.color}44`, fontWeight: 700 }}>{m.label}</span></td>
                        <td style={td}>
                          {t.aiReview ? (
                            <button style={btn} onClick={() => setExpandedReview(expandedReview === t.id ? null : t.id)}>{expandedReview === t.id ? "Hide" : "📖 Read"}</button>
                          ) : (
                            <button style={btn} onClick={() => aiReview(t.id)} disabled={reviewing !== null}>{reviewing === t.id ? "⏳" : "🧠 AI"}</button>
                          )}
                        </td>
                        <td style={td}><button style={{ ...btn, color: "#ef4444" }} onClick={() => remove(t)}>✕</button></td>
                      </tr>
                      {expandedReview === t.id && t.aiReview && (
                        <tr><td colSpan={8} style={{ ...td, background: "rgba(168,85,247,0.05)", color: "#e2d9f3", fontFamily: "inherit", fontSize: "12.5px", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>🧠 {t.aiReview}</td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ fontSize: "11px", color: "#576575", fontFamily: "monospace" }}>
        {isPb
          ? "Practice journal (data/playback_trades.json) — historical data pe decision-making ki training, real paisa nahi."
          : "Ye tumhara personal journal hai (data/mytrades.json mein save) — educational tracking, financial advice nahi."}
      </div>
    </div>
  );
}
