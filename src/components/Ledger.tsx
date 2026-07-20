import React, { useState } from "react";

export interface TradeRecord {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  win: boolean;
  depthPct?: number;
  durationM?: number;
  forced?: boolean;
}

export interface LedgerRow {
  symbol: string;
  name: string;
  strategyId: string;
  strategyLabel: string;
  entryCond: string;
  exitCond: string;
  lastEntryPrice: number | null;
  lastExitPrice: number | null;
  lastReturnPct: number | null;
  winRatePct: number;
  profitFactor: number;
  numTrades: number;
  avgReturnPct: number;
  maxDrawdownPct: number;
  liveSignal: boolean;
  livePrice: number | null;
  liveStop?: number | null;
  liveTarget?: number | null;
  isSynthetic?: boolean;
  tradesKey?: string;
  trades?: TradeRecord[];                                        // playback snapshots ship trades inline
  openPosition?: { entryDate: string; entryPrice: number } | null; // playback: position open on that date
  patternDepth?: number;
  patternDuration?: number;
  hasChart?: boolean;
}

interface LedgerProps {
  rows: LedgerRow[];
  showStrategy: boolean;
  sortField: keyof LedgerRow | null;
  sortAsc: boolean;
  onSort: (field: keyof LedgerRow) => void;
  historyStart: string; // YYYY-MM-DD — only signals on/after this date are shown
  strictHighlight?: boolean; // M2: badge rows meeting the strict 15-trade / PF 2.5 standard
  onTradeTaken?: () => void; // notify parent so the "My Trades" tab badge updates
  playbackDate?: string | null; // set => TIME MACHINE mode: rows are an as-of-this-date snapshot
  onOpenChart?: (symbol: string, name?: string) => void; // triggers divergence chart modal
}

const fmt = (v: number | null, d = 2) => (v === null || v === undefined ? "—" : v.toFixed(d));

export function Ledger({
  rows,
  showStrategy,
  sortField,
  sortAsc,
  onSort,
  historyStart,
  strictHighlight,
  onTradeTaken,
  playbackDate,
  onOpenChart
}: LedgerProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tradesCache, setTradesCache] = useState<Record<string, TradeRecord[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  // "✋ Take this trade" mini-form state
  const [takeOpen, setTakeOpen] = useState<string | null>(null); // rowKey of open form
  const [tEntry, setTEntry] = useState("");
  const [tStop, setTStop] = useState("");
  const [tTarget, setTTarget] = useState("");
  const [takeMsg, setTakeMsg] = useState("");
  const [taking, setTaking] = useState(false);
  
  // Playback practice-trade form uses PERCENTAGES (entry fills at next session's open)
  const [tStopPct, setTStopPct] = useState("");
  const [tTargetPct, setTTargetPct] = useState("");

  const colCount = showStrategy ? 13 : 12;

  const renderSortIcon = (field: keyof LedgerRow) => {
    if (sortField !== field) return <span className="sort-icon">↕</span>;
    return sortAsc ? <span className="sort-icon active">▲</span> : <span className="sort-icon active">▼</span>;
  };

  const toggleRow = async (r: LedgerRow) => {
    const rowKey = r.symbol + r.strategyId;
    if (expanded === rowKey) { setExpanded(null); return; }
    setExpanded(rowKey);
    const key = r.tradesKey || `${r.symbol}__${r.strategyId}`;
    if (r.trades) { // playback snapshot rows carry their as-of trades inline
      setTradesCache((prev) => ({ ...prev, [key]: r.trades! }));
      return;
    }
    if (!tradesCache[key]) {
      setLoadingKey(key);
      try {
        const res = await fetch(`/cache/trades/${encodeURIComponent(key)}.json`);
        const isJson = res.headers.get("content-type")?.includes("application/json");
        const data = (res.ok && isJson) ? await res.json() : [];
        setTradesCache((prev) => ({ ...prev, [key]: Array.isArray(data) ? data : [] }));
      } catch {
        setTradesCache((prev) => ({ ...prev, [key]: [] }));
      } finally {
        setLoadingKey(null);
      }
    }
  };

  const formatDateHuman = (dateStr: string) => {
    if (!dateStr) return "";
    const parts = dateStr.split("-");
    if (parts.length !== 3) return dateStr;
    const [y, m, d] = parts;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mIdx = parseInt(m, 10) - 1;
    return `${parseInt(d, 10)} ${months[mIdx] || m} ${y}`;
  };

  const openTakeForm = (r: LedgerRow) => {
    const rowKey = r.symbol + r.strategyId;
    const isM2 = r.strategyId === "m2_rounding_bottom";

    if (playbackDate) {
      if (r.livePrice && r.liveStop && r.liveTarget) {
        // Real backtest-derived levels available (ATR-based, fixed R:R, or m4's structural) — pre-fill from those
        const sPct = Math.max(0.1, ((r.livePrice - r.liveStop) / r.livePrice) * 100);
        const tPct = Math.max(0.1, ((r.liveTarget - r.livePrice) / r.livePrice) * 100);
        setTStopPct(sPct.toFixed(1));
        setTTargetPct(tPct.toFixed(1));
      } else {
        setTStopPct(String(isM2 ? 5 : 8));
        setTTargetPct(String(isM2 ? 15 : Math.max(3, Math.round(r.avgReturnPct))));
      }
      setTakeMsg("");
      setTakeOpen(rowKey);
      return;
    }

    // LIVE row → prefill from live price
    const base = r.liveSignal && r.livePrice ? r.livePrice : 0;
    setTEntry(base ? String(base) : "");
    if (r.livePrice && r.liveStop && r.liveTarget) {
      setTStop(String(Math.round(r.liveStop)));
      setTTarget(String(Math.round(r.liveTarget)));
    } else {
      setTStop(base ? String(Math.round(base * (isM2 ? 0.95 : 0.92))) : "");
      setTTarget(base ? String(isM2 ? Math.round(base * 1.15) : Math.round(base * (1 + Math.max(r.avgReturnPct, 3) / 100))) : "");
    }
    setTakeMsg("");
    setTakeOpen(rowKey);
  };

  const recalcFromEntry = (r: LedgerRow, entryStr: string) => {
    setTEntry(entryStr);
    const e = Number(entryStr);
    if (isFinite(e) && e > 0) {
      const isM2 = r.strategyId === "m2_rounding_bottom";
      if (r.livePrice && r.liveStop && r.liveTarget) {
        // Adjust ATR/structural/fixed-R:R SL/target relative to actual fill entry ratio
        const slip = e / r.livePrice;
        setTStop(String(Math.round(r.liveStop * slip)));
        setTTarget(String(Math.round(r.liveTarget * slip)));
      } else {
        setTStop(String(Math.round(e * (isM2 ? 0.95 : 0.92))));
        setTTarget(String(isM2 ? Math.round(e * 1.15) : Math.round(e * (1 + Math.max(r.avgReturnPct, 3) / 100))));
      }
    }
  };

  const submitPlaybackTake = async (r: LedgerRow) => {
    const stopPct = Number(tStopPct), targetPct = Number(tTargetPct);
    if (!isFinite(stopPct) || stopPct <= 0 || stopPct >= 50) { setTakeMsg("❌ Stop% 0-50 ke beech do"); return; }
    if (!isFinite(targetPct) || targetPct <= 0) { setTakeMsg("❌ Target% valid do"); return; }
    setTaking(true);
    try {
      const res = await fetch("/api/playback/trades/take", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: r.symbol,
          name: r.name,
          strategyId: r.strategyId,
          strategyLabel: r.strategyLabel,
          module: r.strategyId === "m2_rounding_bottom" ? "m2" : r.strategyId === "m4_divergence" ? "m4" : r.strategyId === "m3_best_overall" ? "m3" : "m1",
          signalDate: playbackDate,
          stopPct,
          targetPct,
          depthPct: r.patternDepth,
          durationM: r.patternDuration
        })
      });
      const d = await res.json();
      if (d.ok) {
        setTakeMsg("✅ Practice journal mein add — entry AGLE session ke open pe hogi, din aage badhao");
        setTakeOpen(null);
        if (onTradeTaken) onTradeTaken();
      } else setTakeMsg(`❌ ${d.error || "save fail"}`);
    } catch {
      setTakeMsg("❌ Server se connect nahi hua");
    } finally {
      setTaking(false);
    }
  };

  const submitTake = async (r: LedgerRow) => {
    const entryPrice = Number(tEntry);
    const isM6 = r.strategyId === "m6_connors_rsi";
    if (!isFinite(entryPrice) || entryPrice <= 0) { setTakeMsg("❌ Valid entry price daalo"); return; }
    // M6: indicator-based exit — no fixed stop/target needed
    const stopPrice  = isM6 ? Math.round(entryPrice * 0.92) : Number(tStop);
    const targetPrice = isM6 ? Math.round(entryPrice * (1 + Math.max(r.avgReturnPct, 3) / 100)) : Number(tTarget);
    if (!isM6) {
      if (!isFinite(stopPrice) || stopPrice >= entryPrice) { setTakeMsg("❌ Stop-loss entry se NEECHE hona chahiye"); return; }
      if (!isFinite(targetPrice) || targetPrice <= entryPrice) { setTakeMsg("❌ Target entry se UPAR hona chahiye"); return; }
    }
    setTaking(true);
    try {
      // Playback mode me alag endpoint — live journal me nahi jaayega
      if (playbackDate) {
        const res = await fetch("/api/playback/trades/take", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: r.symbol,
            name: r.name,
            strategyId: r.strategyId,
            strategyLabel: r.strategyLabel,
            signalDate: playbackDate,
            stopPct: isM6 ? 8 : Math.round((entryPrice - stopPrice) / entryPrice * 100 * 10) / 10,
            targetPct: isM6 ? Math.max(r.avgReturnPct, 3) : Math.round((targetPrice - entryPrice) / entryPrice * 100 * 10) / 10,
          })
        });
        const d = await res.json();
        if (d.ok) {
          setTakeMsg("✅ Practice journal mein add ho gaya — 'My Trades' tab mein track hoga");
          setTakeOpen(null);
          if (onTradeTaken) onTradeTaken();
        } else setTakeMsg(`❌ ${d.error || "save fail"}`);
        return;
      }
      const res = await fetch("/api/trades/take", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: r.symbol,
          name: r.name,
          strategyId: r.strategyId,
          strategyLabel: r.strategyLabel,
          module: r.strategyId === "m2_rounding_bottom" ? "m2" : r.strategyId === "m4_divergence" ? "m4" : r.strategyId === "m3_best_overall" ? "m3" : "m1",
          entryPrice,
          stopPrice,
          targetPrice,
          depthPct: r.patternDepth,
          durationM: r.patternDuration
        })
      });
      const d = await res.json();
      if (d.ok) {
        setTakeMsg("✅ Journal mein add ho gaya — 'My Trades' tab mein track hoga");
        setTakeOpen(null);
        if (onTradeTaken) onTradeTaken();
      } else setTakeMsg(`❌ ${d.error || "save fail"}`);
    } catch {
      setTakeMsg("❌ Server se connect nahi hua");
    } finally {
      setTaking(false);
    }
  };

  const inp: React.CSSProperties = { background: "#0f141c", border: "1px solid #2a3342", color: "#e6edf5", borderRadius: "6px", padding: "4px 8px", fontFamily: "monospace", width: "92px", fontSize: "12px" };

  const renderTakeSection = (r: LedgerRow) => {
    const rowKey = r.symbol + r.strategyId;
    const formOpen = takeOpen === rowKey;
    if (playbackDate) {
      if (!r.liveSignal) return null;
      return (
        <div className="mb-3">
          {!formOpen ? (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => openTakeForm(r)}
                className="bg-linear-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white font-extrabold border-none rounded-lg px-4 py-1.5 text-xs cursor-pointer shadow-md transition-all duration-150"
              >
                ✋ Take this trade (practice)
              </button>
              {takeMsg && <span className={`text-xs font-mono ${takeMsg.startsWith("✅") ? "text-green-500" : "text-red-500"}`}>{takeMsg}</span>}
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-purple-500/5 border border-purple-500/40 font-mono text-xs text-slate-300">
              <div className="font-bold text-purple-400 mb-2">🕰 Practice trade — {r.symbol.replace(".NS", "")} @ signal {playbackDate}</div>
              <div className="flex flex-wrap gap-3 items-center">
                <label className="flex items-center gap-1">Stop-loss % <input style={{ ...inp, borderColor: "rgba(239,68,68,0.5)", width: "64px" }} value={tStopPct} onChange={(e) => setTStopPct(e.target.value)} /></label>
                <label className="flex items-center gap-1">Target % <input style={{ ...inp, borderColor: "rgba(34,197,94,0.5)", width: "64px" }} value={tTargetPct} onChange={(e) => setTTargetPct(e.target.value)} /></label>
                <button onClick={() => submitPlaybackTake(r)} disabled={taking} className="bg-purple-600 hover:bg-purple-700 text-white font-extrabold border-none rounded-sm px-3 py-1 cursor-pointer text-xs disabled:opacity-60">
                  {taking ? "Saving…" : "✓ Lock decision"}
                </button>
                <button onClick={() => setTakeOpen(null)} className="bg-transparent text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-600 rounded-sm px-3 py-1 cursor-pointer text-xs">Cancel</button>
              </div>
              <div className="text-slate-500 text-[10px] mt-1.5">
                Entry <strong>agle trading session ke open</strong> pe fill hogi (jaise engine karta hai) — % levels abhi lock ho rahe hain, bilkul real jaise.
              </div>
              {takeMsg && <div className={`mt-1.5 ${takeMsg.startsWith("✅") ? "text-green-500" : "text-red-500"}`}>{takeMsg}</div>}
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="mb-3">
        {!formOpen ? (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => openTakeForm(r)}
              className="bg-linear-to-r from-amber-400 to-amber-600 hover:from-amber-500 hover:to-amber-700 text-slate-950 font-extrabold border-none rounded-lg px-4 py-1.5 text-xs cursor-pointer shadow-md transition-all duration-150"
            >
              ✋ Take this trade
            </button>
            {takeMsg && <span className={`text-xs font-mono ${takeMsg.startsWith("✅") ? "text-green-500" : "text-red-500"}`}>{takeMsg}</span>}
          </div>
        ) : (
          <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/35 font-mono text-xs text-slate-300">
            <div className="font-bold text-amber-400 mb-2">✋ Taking {r.symbol.replace(".NS", "")} — apna actual plan confirm karo</div>
            {r.strategyId === "m6_connors_rsi" ? (
              // M6: indicator-based exit — Stop/Target fields nahi, sirf Entry + note
              <div>
                <div className="flex flex-wrap gap-3 items-center mb-2">
                  <label className="flex items-center gap-1">Entry ₹ <input style={inp} value={tEntry} onChange={(e) => setTEntry(e.target.value)} placeholder="e.g. 40855" /></label>
                  <button onClick={() => submitTake(r)} disabled={taking} className="bg-green-600 hover:bg-green-700 text-slate-950 font-extrabold border-none rounded-sm px-3 py-1 cursor-pointer text-xs disabled:opacity-60">
                    {taking ? "Saving…" : "✓ Confirm"}
                  </button>
                  <button onClick={() => setTakeOpen(null)} className="bg-transparent text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-600 rounded-sm px-3 py-1 cursor-pointer text-xs">Cancel</button>
                </div>
                <div className="text-cyan-400/80 text-[11px] mt-1 leading-5">
                  🎯 Exit: <strong>ConnorsRSI &gt; 90 hone pe</strong> — app "My Trades" me exit signal dikhayega<br/>
                  🛡️ Emergency floor: entry se <strong>−8%</strong> neeche gaye to manually exit karo
                </div>
              </div>
            ) : r.strategyId === "m7_turtle_soup" ? (
              // M7 Turtle Soup: BUY 1:2 RR, SELL 1:1.2 RR — liveStop/liveTarget already computed
              <div>
                <div className="flex flex-wrap gap-3 items-center mb-2">
                  <label className="flex items-center gap-1">Entry ₹ <input style={inp} value={tEntry} onChange={(e) => recalcFromEntry(r, e.target.value)} placeholder="e.g. 542" /></label>
                  <label className="flex items-center gap-1">Stop ₹ <input style={{ ...inp, borderColor: "rgba(239,68,68,0.5)" }} value={tStop} onChange={(e) => setTStop(e.target.value)} /></label>
                  <label className="flex items-center gap-1">Target ₹ <input style={{ ...inp, borderColor: "rgba(34,197,94,0.5)" }} value={tTarget} onChange={(e) => setTTarget(e.target.value)} /></label>
                  <button onClick={() => submitTake(r)} disabled={taking} className="bg-green-600 hover:bg-green-700 text-slate-950 font-extrabold border-none rounded-sm px-3 py-1 cursor-pointer text-xs disabled:opacity-60">
                    {taking ? "Saving…" : "✓ Confirm"}
                  </button>
                  <button onClick={() => setTakeOpen(null)} className="bg-transparent text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-600 rounded-sm px-3 py-1 cursor-pointer text-xs">Cancel</button>
                </div>
                <div className="text-emerald-400/80 text-[11px] mt-1 leading-5">
                  {Number(tEntry) > 0 && Number(tTarget) > Number(tEntry)
                    ? <>🐢 BUY — <strong>1:2 Risk:Reward</strong> · Entry ₹{tEntry} · Stop ₹{tStop} · Target ₹{tTarget}</>
                    : Number(tEntry) > 0 && Number(tTarget) < Number(tEntry)
                    ? <>🐢 SELL — <strong>1:1.2 Risk:Reward</strong> · Entry ₹{tEntry} · Stop ₹{tStop} · Target ₹{tTarget}</>
                    : <>🐢 Turtle Soup — BUY side: 1:2 RR · SELL side: 1:1.2 RR</>
                  }
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-3 items-center">
                <label className="flex items-center gap-1">Entry ₹ <input style={inp} value={tEntry} onChange={(e) => recalcFromEntry(r, e.target.value)} placeholder="e.g. 3048" /></label>
                <label className="flex items-center gap-1">Stop ₹ <input style={{ ...inp, borderColor: "rgba(239,68,68,0.5)" }} value={tStop} onChange={(e) => setTStop(e.target.value)} /></label>
                <label className="flex items-center gap-1">Target ₹ <input style={{ ...inp, borderColor: "rgba(34,197,94,0.5)" }} value={tTarget} onChange={(e) => setTTarget(e.target.value)} /></label>
                <button onClick={() => submitTake(r)} disabled={taking} className="bg-green-600 hover:bg-green-700 text-slate-950 font-extrabold border-none rounded-sm px-3 py-1 cursor-pointer text-xs disabled:opacity-60">
                  {taking ? "Saving…" : "✓ Confirm"}
                </button>
                <button onClick={() => setTakeOpen(null)} className="bg-transparent text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-600 rounded-sm px-3 py-1 cursor-pointer text-xs">Cancel</button>
              </div>
            )}
            {!r.liveSignal && r.strategyId !== "m6_connors_rsi" && (
              <div className="text-amber-500 text-[10px] mt-1.5">⚠️ Is stock pe abhi LIVE signal nahi hai — apne broker ka ACTUAL entry price daalo, purane backtest price pe mat jao.</div>
            )}
            {takeMsg && <div className={`mt-1.5 ${takeMsg.startsWith("✅") ? "text-green-500" : "text-red-500"}`}>{takeMsg}</div>}
          </div>
        )}
      </div>
    );
  };

  const renderTodayPlan = (r: LedgerRow) => {
    if (playbackDate && r.openPosition && !r.liveSignal) {
      return (
        <div className="mb-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/35 font-mono text-xs text-amber-100">
          <div className="font-bold text-amber-400 mb-1">🟡 Position OPEN on this date</div>
          <div>Strategy is date pe position mein tha — entry <strong>{r.openPosition.entryDate}</strong> @ <strong>₹{Math.round(r.openPosition.entryPrice)}</strong>. Exit abhi future mein hai — din aage badha ke dekho.</div>
        </div>
      );
    }
    if (r.liveSignal && r.livePrice) {
      const entry = r.livePrice;
      const isM2 = r.strategyId === "m2_rounding_bottom";
      const isM4 = r.strategyId === "m4_divergence";
      const isM6 = r.strategyId === "m6_connors_rsi";
      const isStoch = r.strategyId === "m1_stoch_rsi";

      // M4: agar current price entry se 2% se zyada door ho to signal expired
      if (isM4 && r.lastExitPrice && r.lastExitPrice > 0) {
        const drift = Math.abs((r.lastExitPrice - entry) / entry) * 100;
        if (drift > 2) {
          const dir = r.lastExitPrice > entry ? "upar" : "neeche";
          return (
            <div className="mb-3 p-3 rounded-lg bg-orange-500/5 border border-orange-500/40 font-mono text-xs text-orange-100">
              <div className="font-bold text-orange-400 mb-1">⚠️ Entry Expired — signal purana ho gaya</div>
              <div>Signal entry zone tha <strong>₹{Math.round(entry)}</strong>, par price ab <strong>₹{Math.round(r.lastExitPrice)}</strong> pe hai — <strong>{drift.toFixed(1)}% {dir}</strong> nikal gaya (2% threshold se zyada). Is signal pe ab nahi lena chahiye, agli divergence ka wait karo.</div>
            </div>
          );
        }
      }

      // M6: ConnorsRSI — indicator-based exit, no fixed SL/target
      if (isM6) {
        const emergencyStop = Math.round(entry * 0.92);
        return (
          <div className="mb-3 p-3 rounded-lg bg-green-500/5 border border-green-500/35 font-mono text-xs text-green-100">
            <div className="font-bold text-green-400 mb-1">📍 {playbackDate ? `Signal on ${playbackDate} (as-of close that day)` : "LIVE setup (as of latest close)"}</div>
            <div>Entry zone ≈ <strong>₹{Math.round(entry)}</strong> · ConnorsRSI(3,2,100) &lt; 15 + Price &gt; EMA(200)</div>
            <div className="mt-1">Exit: <strong>ConnorsRSI &gt; 90 hone pe close pe exit</strong> (avg hold ~46 days)</div>
            <div className="mt-1">Emergency floor: <strong>₹{emergencyStop}</strong> (−8% from entry) — sirf emergency me, indicator exit hi primary hai</div>
            <div className="text-slate-500 text-[10px] mt-1.5">OOS validated: Banks+Pharma+Power me PF 2.59, Win 68.2%. Enter only if price is still near entry zone.</div>
          </div>
        );
      }

      let stop = 0, target = 0, stopPct = 0, targetLabel = "", exitLabel = "";

      if (r.liveStop && r.liveTarget) {
        stop = Math.round(r.liveStop);
        target = Math.round(r.liveTarget);
        stopPct = Math.round(((entry - stop) / entry) * 100);
        targetLabel = isM4 ? "ATR-based exit rule (2.5x SL / 5x target)" : "backtest-validated exit rule";
      } else {
        stopPct = isM2 ? 5 : 8;
        stop = Math.round(entry * (1 - stopPct / 100));
        target = isM2 ? Math.round(entry * 1.15) : Math.round(entry * (1 + r.avgReturnPct / 100));
        targetLabel = isM2 ? "+15% rule" : `+${r.avgReturnPct.toFixed(1)}% avg`;
      }

      // StochRSI: show indicator exit label
      exitLabel = isStoch
        ? "Exit: StochRSI K crosses D above 80 (emergency floor: −8% from entry)"
        : "";

      const risk = entry - stop;
      const reward = target - entry;
      const rr = risk > 0 ? (reward / risk).toFixed(1) : "—";
      return (
        <div className="mb-3 p-3 rounded-lg bg-green-500/5 border border-green-500/35 font-mono text-xs text-green-100">
          <div className="font-bold text-green-400 mb-1">📍 {playbackDate ? `Signal on ${playbackDate} (as-of close that day)` : "LIVE setup (as of latest close)"}</div>
          <div>Entry zone ≈ <strong>₹{entry}</strong> · Stop-loss <strong>₹{stop}</strong> (−{stopPct}%) · Target ≈ <strong>₹{target}</strong> ({targetLabel}) · R:R ≈ 1:{rr}</div>
          {exitLabel && <div className="mt-1 text-yellow-300/80">{exitLabel}</div>}
          <div className="text-slate-500 text-[10px] mt-1.5">Enter only if price is still near the entry zone. Backtest-derived levels — educational, not financial advice.</div>
        </div>
      );
    }
    return (
      <div className="mb-3 p-3 rounded-lg bg-slate-500/5 border border-slate-700 font-mono text-xs text-slate-400">
        <div className="font-bold text-slate-400 mb-1">⚪ No live entry today — history only</div>
        <div>
          The trades below are <strong>past backtest signals</strong>{r.lastEntryPrice ? ` (last one entered at ₹${Math.round(r.lastEntryPrice)}, long gone)` : ""}. Don't buy at those old prices. Wait for a <strong>LIVE</strong> signal — use the “LIVE Signals Only” filter to see stocks that are entry-ready now.
        </div>
      </div>
    );
  };

  const renderHistory = (r: LedgerRow) => {
    const key = r.tradesKey || `${r.symbol}__${r.strategyId}`;
    const all = tradesCache[key];
    if (loadingKey === key || all === undefined) {
      return <div className="p-4 text-slate-400 font-mono text-xs">Loading trade history…</div>;
    }
    const filtered = all
      .filter((t) => t.entryDate >= historyStart)
      .sort((a, b) => b.entryDate.localeCompare(a.entryDate));
    if (!filtered.length) {
      return (
        <div className="p-3">
          {renderTodayPlan(r)}
          {renderTakeSection(r)}
          <div className="text-slate-400 font-mono text-xs">
            No signals found since <strong>{formatDateHuman(historyStart)}</strong> (out of {all.length} total backtest signals).
          </div>
        </div>
      );
    }
    const wins = filtered.filter((t) => t.win).length;
    const losses = filtered.length - wins;
    const wr = Math.round((wins / filtered.length) * 100);
    return (
      <div className="p-3">
        {renderTodayPlan(r)}
        {renderTakeSection(r)}
        <div className="mb-3 text-xs text-slate-300 font-mono flex flex-wrap items-center gap-2">
          <span className="bg-blue-500/15 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded-sm text-[10px] font-bold">
            DATE FILTER ACTIVE
          </span>
          <span>
            Showing <strong>{filtered.length}</strong> of <strong>{all.length}</strong> total backtest signals since <strong>{formatDateHuman(historyStart)}</strong> —{" "}
            <span className="text-green-400">{wins} profit</span> ·{" "}
            <span className="text-red-400">{losses} loss</span> · <strong>{wr}% win rate</strong>
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-slate-400 text-left">
                <th className="p-2">Entry Date</th>
                <th className="p-2">Exit Date</th>
                <th className="p-2">Entry ₹</th>
                <th className="p-2">Exit ₹</th>
                <th className="p-2">Return</th>
                <th className="p-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, j) => (
                <tr key={j} className="border-t border-slate-800">
                  <td className="p-2 font-mono">{t.entryDate}</td>
                  <td className="p-2 font-mono">{t.exitDate}</td>
                  <td className="p-2 font-mono">{t.entryPrice}</td>
                  <td className="p-2 font-mono">{t.exitPrice}</td>
                  <td className={`p-2 font-mono ${t.win ? "text-green-400" : "text-red-400"}`}>
                    {(t.returnPct >= 0 ? "+" : "") + t.returnPct}%
                  </td>
                  <td className="p-2">
                    <span className={`px-1.5 py-0.5 rounded-sm text-[10px] font-bold ${t.win ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>{t.win ? "PROFIT" : "LOSS"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="ledger-wrap overflow-x-auto">
      <table className="ledger min-w-full">
        <thead>
          <tr>
            <th className="l sortable cursor-pointer" onClick={() => onSort("symbol")}>
              Stock {renderSortIcon("symbol")}
            </th>
            {showStrategy && (
              <th className="l sortable cursor-pointer" onClick={() => onSort("strategyLabel")}>
                Strategy {renderSortIcon("strategyLabel")}
              </th>
            )}
            <th className="l text-left p-3">Entry Condition</th>
            <th className="sortable cursor-pointer" onClick={() => onSort("lastEntryPrice")}>
              Entry ₹ {renderSortIcon("lastEntryPrice")}
            </th>
            <th className="l text-left p-3">Exit Condition</th>
            <th className="sortable cursor-pointer" onClick={() => onSort("lastExitPrice")}>
              Exit ₹ {renderSortIcon("lastExitPrice")}
            </th>
            <th className="sortable cursor-pointer" onClick={() => onSort("lastReturnPct")}>
              Return {renderSortIcon("lastReturnPct")}
            </th>
            <th className="sortable cursor-pointer" onClick={() => onSort("winRatePct")}>
              Win% {renderSortIcon("winRatePct")}
            </th>
            <th className="sortable cursor-pointer" onClick={() => onSort("profitFactor")}>
              PF {renderSortIcon("profitFactor")}
            </th>
            <th className="sortable cursor-pointer" onClick={() => onSort("numTrades")}>
              Trades {renderSortIcon("numTrades")}
            </th>
            <th className="sortable cursor-pointer" onClick={() => onSort("avgReturnPct")}>
              Avg {renderSortIcon("avgReturnPct")}
            </th>
            <th className="sortable cursor-pointer" onClick={() => onSort("maxDrawdownPct")}>
              MaxDD {renderSortIcon("maxDrawdownPct")}
            </th>
            <th className="sortable cursor-pointer" onClick={() => onSort("liveSignal")}>
              Signal {renderSortIcon("liveSignal")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const cleanSym = r.symbol.replace(".NS", "");
            const returnPct = r.lastReturnPct;
            
            let returnClass = "badge-neutral";
            if (returnPct !== null && returnPct !== undefined) {
              returnClass = returnPct >= 0 ? "badge-success" : "badge-danger";
            }

            const avgReturnClass = r.avgReturnPct >= 0 ? "text-success" : "text-danger";
            const isStrict = r.numTrades >= 15 && r.profitFactor >= 2.5 && r.winRatePct >= 60;
            const rowKey = r.symbol + r.strategyId;
            const isOpen = expanded === rowKey;

            return (
              <React.Fragment key={rowKey + i}>
                <tr className={r.liveSignal ? "row-live" : ""}>
                  <td className="l sym" style={{ cursor: "pointer" }} onClick={() => toggleRow(r)} title="Click to view full signal history">
                    <div className="sym-box">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-amber-500 font-mono w-[10px] inline-block">{isOpen ? "▾" : "▸"}</span>
                        <span className="sym-ticker">{cleanSym}</span>
                        
                        {r.hasChart && onOpenChart && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenChart(r.symbol, r.name);
                            }}
                            className="bg-purple-900/40 hover:bg-purple-800/80 text-purple-300 border border-purple-500/35 px-1 rounded-sm text-[9.5px] font-bold cursor-pointer flex items-center gap-0.5"
                            title="Open interactive divergence chart"
                          >
                            📈 Chart
                          </button>
                        )}

                        {r.isSynthetic && (
                          <span className="text-[10px] bg-amber-500/15 text-amber-500 border border-amber-500/30 px-1 py-0 rounded-sm font-normal font-mono">
                            SYNTHETIC
                          </span>
                        )}
                        {strictHighlight && isStrict && (
                          <span className="text-[10px] bg-green-500/15 text-green-500 border border-green-500/40 px-1.5 py-0 rounded-sm font-bold font-mono">
                            STRICT ✓
                          </span>
                        )}
                      </div>
                      <span className="sym-name">{r.name}</span>
                    </div>
                  </td>
                  {showStrategy && <td className="l strategy-cell">{r.strategyLabel}</td>}
                  <td className="cond entry-cond text-left p-3">{r.entryCond}</td>
                  <td className="mono font-semibold text-center p-3">{fmt(r.lastEntryPrice)}</td>
                  <td className="cond exit-cond text-left p-3">{r.exitCond}</td>
                  <td className="mono font-semibold text-center p-3">{fmt(r.lastExitPrice)}</td>
                  <td className="text-center p-3">
                    <span className={`badge ${returnClass}`}>
                      {returnPct === null || returnPct === undefined ? "—" : (returnPct >= 0 ? "+" : "") + fmt(returnPct) + "%"}
                    </span>
                  </td>
                  <td className="mono text-center p-3">{fmt(r.winRatePct, 1)}%</td>
                  <td className="text-center p-3">
                    <span className={`pf-value ${r.profitFactor >= 2 ? "pf-premium" : "pf-standard"}`}>
                      {fmt(r.profitFactor, 2)}
                    </span>
                  </td>
                  <td className="mono text-center p-3">{r.numTrades}</td>
                  <td className={`mono ${avgReturnClass} text-center p-3`}>
                    {(r.avgReturnPct >= 0 ? "+" : "") + fmt(r.avgReturnPct) + "%"}
                  </td>
                  <td className="mono text-danger-dim text-center p-3">{fmt(r.maxDrawdownPct, 1)}%</td>
                  <td className="text-center p-3">
                    {r.liveSignal ? (
                      <span className="live-pill"><span className="pulse-dot" />LIVE</span>
                    ) : (
                      <span className="live-pill off"><span className="pulse-dot" />OFF</span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="trade-history-row">
                    <td colSpan={colCount} style={{ background: "#0b0f16", borderTop: "1px solid #1b2230" }}>
                      {renderHistory(r)}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}