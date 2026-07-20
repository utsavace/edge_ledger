import React, { useEffect, useState, useMemo, useRef } from "react";
import { Ledger, type LedgerRow } from "./components/Ledger.tsx";
import { MyTrades } from "./components/MyTrades.tsx";
// DivergenceChart removed — M4 Weekly Divergence module removed
// ExitSchemeComparison removed — replaced by ConnorsRSI (M6) module

interface Meta {
  needsScan?: boolean;
  stale?: boolean;        // ← add
  reason?: string;        // ← add
  generatedAt?: string;
  universeCount?: number;
  scanned?: number;
  withData?: number;
  elapsedSec?: number;
  gate?: {
    minWinRate: number;
    minProfitFactor: number;
    minOosTrades: number;
    strict?: { minProfitFactor: number; minOosTrades: number };
  };
  walkForward?: { trainFrac: number; note: string };
  backtestMethod?: { type: string; note: string };
  passed?: number;
}

interface Bucketed {
  label: string;
  buckets: { range: string; trades: number; winRatePct: number }[];
}

const TABS = [
  { n: 1, key: "stoch", label: "StochRSI Scanner" },
  { n: 6, key: "connors", label: "ConnorsRSI Oversold" },
  { n: 7, key: "turtle", label: "Turtle Soup" },
  { n: 5, key: "journal", label: "My Trades" },
] as const;

const DESC: Record<number, string> = {
  1: "Stochastic RSI Trend Filter — StochRSI K crosses D below 15 + ADX > 20 → next bar open pe entry. Exit: K crosses D above 80. 10yr zero-lookahead OOS validated: PF 1.71, Win 58.3%, 6/6 years profitable. Gate: 10 trades / 55% WR / 1.5 PF. 🔵 Live signal filter: ADX ≥ 29 wale stocks hi dikhenge.",
  6: "ConnorsRSI(3,2,100) oversold scanner — Price > EMA(200) + ConnorsRSI < 15 (deeply oversold in uptrend) → next bar open pe entry. Exit: ConnorsRSI > 90. 10yr OOS validated: PF 2.74, Win 72.1%, 5/5 years profitable. Gate: 10 trades / 60% WR / 1.5 PF. 🔵 Live signal filter: ADX ≥ 29 wale stocks hi dikhenge.",
  7: "Turtle Soup (Connors & Raschke, Street Smarts 1995) — New 20-day low bana + previous 20-day low 4+ sessions pehle tha → false breakdown reversal. BUY: entry above previous low, SL today's low, Target 1:2 RR. SELL: entry below previous high, SL today's high, Target 1:1.2 RR. No gate — all stocks. 10yr OOS: PF 1.64, Win 64.4%, 10/10 years profitable.",
  5: "Tumhara personal trade journal — jis stock ka trade lena ho usse yahan save karo. App rooz check karta hai ki exit signal aaya ya nahi aur status dikhata hai: Holding ✅ ya EXIT ⚠️.",
};

export default function App() {
  const [tab, setTab] = useState(1);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [liveOnly, setLiveOnly] = useState(false);
  const [m6SectorFilter, setM6SectorFilter] = useState(false);
  const [historyStart, setHistoryStart] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 5); // default: last 5 years; pick any older date to go further back
    return d.toISOString().slice(0, 10);
  });
  const [sortField, setSortField] = useState<keyof LedgerRow | null>(null);
  const [sortAsc, setSortAsc] = useState(false);
  const [journalCount, setJournalCount] = useState<number | null>(null);

  // Divergence Chart state

  // Load journal count once for the tab badge
  useEffect(() => {
    fetch(`/api/trades?t=${Date.now()}`)
      .then((r) => r.json())
      .then((d) => setJournalCount(Array.isArray(d.trades) ? d.trades.length : 0))
      .catch(() => setJournalCount(0));
  }, []);

  // ==================== PLAYBACK (TIME MACHINE) ====================
  const [pbOn, setPbOn] = useState(false);
  const [pbDate, setPbDate] = useState<string | null>(null);
  const [pbAxis, setPbAxis] = useState<string[]>([]);
  const [pbSnap, setPbSnap] = useState<any | null>(null);
  const [pbLoading, setPbLoading] = useState(false);
  const [pbErr, setPbErr] = useState("");
  const [pbPlaying, setPbPlaying] = useState(false);
  const [pbSpeedMs, setPbSpeedMs] = useState(1200);
  const [pbJournalCount, setPbJournalCount] = useState<number | null>(null);
  const [pbOpenCount, setPbOpenCount] = useState(0);   // OPEN/PENDING practice trades → drives step-checks
  const [pbPauseMsg, setPbPauseMsg] = useState("");    // "auto-paused because your trade resolved" banner
  const pbFetchSeq = useRef(0);
  const pbCheckBusy = useRef(false);

  const enterPlayback = async () => {
    setPbErr("");
    try {
      const r = await fetch(`/api/playback/axis?t=${Date.now()}`);
      const d = await r.json();
      if (!r.ok || !d.ok || !Array.isArray(d.dates) || !d.dates.length) {
        setPbErr(d.error || "Playback data nahi mili — pehle ek fresh scan chalao (naya engine playback files banata hai).");
        return;
      }
      setPbAxis(d.dates);
      setPbOn(true);
      // sensible default start: ~1 year back from the data end
      const idx = Math.max(0, d.dates.length - 252);
      setPbDate(d.dates[idx]);
      fetch(`/api/playback/trades?t=${Date.now()}`)
        .then((x) => x.json())
        .then((x) => {
          const list = Array.isArray(x.trades) ? x.trades : [];
          setPbJournalCount(list.length);
          setPbOpenCount(list.filter((t: any) => t.status === "OPEN" || t.status === "PENDING").length);
        })
        .catch(() => setPbJournalCount(0));
    } catch {
      setPbErr("Playback axis load nahi hui — server chal raha hai?");
    }
  };

  const exitPlayback = () => {
    setPbOn(false);
    setPbPlaying(false);
    setPbDate(null);
    setPbSnap(null);
    setPbErr("");
    setPbPauseMsg("");
  };

  // Snap an arbitrary calendar date (picker can select holidays) to the nearest trading day ≤ it
  const snapToAxis = (d: string): string => {
    if (!pbAxis.length) return d;
    if (d <= pbAxis[0]) return pbAxis[0];
    let best = pbAxis[0];
    for (const x of pbAxis) { if (x <= d) best = x; else break; }
    return best;
  };

  const pbStep = (dir: 1 | -1) => {
    if (!pbDate || !pbAxis.length) return;
    const i = pbAxis.indexOf(pbDate);
    const j = (i === -1 ? pbAxis.findIndex((x) => x > pbDate) - 1 : i) + dir;
    if (j < 0 || j >= pbAxis.length) { setPbPlaying(false); return; }
    setPbDate(pbAxis[j]);
  };

  // Fetch the as-of snapshot whenever the virtual date changes (stale responses dropped)
  useEffect(() => {
    if (!pbOn || !pbDate) return;
    const seq = ++pbFetchSeq.current;
    setPbLoading(true);
    fetch(`/api/playback/snapshot?date=${pbDate}&t=${Date.now()}`)
      .then((r) => r.json())
      .then((d) => {
        if (seq !== pbFetchSeq.current) return; // an older request finishing late — ignore
        if (d.ok) { setPbSnap(d); setPbErr(""); } else setPbErr(d.error || "snapshot fail");
      })
      .catch(() => { if (seq === pbFetchSeq.current) setPbErr("Snapshot load fail"); })
      .finally(() => { if (seq === pbFetchSeq.current) setPbLoading(false); });
  }, [pbOn, pbDate]);

  // Auto-play: advance one trading day per tick; stops at the end of data
  useEffect(() => {
    if (!pbPlaying || !pbOn) return;
    const t = setInterval(() => pbStep(1), pbSpeedMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pbPlaying, pbOn, pbSpeedMs, pbDate]);

  // PRACTICE-TRADE WATCHDOG: on every virtual-date move
  useEffect(() => {
    if (!pbOn || !pbDate || pbOpenCount === 0 || pbCheckBusy.current) return;
    pbCheckBusy.current = true;
    fetch("/api/playback/trades/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asOfDate: pbDate })
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) return;
        const list: any[] = Array.isArray(d.trades) ? d.trades : [];
        setPbJournalCount(list.length);
        setPbOpenCount(list.filter((t) => t.status === "OPEN" || t.status === "PENDING").length);
        if (d.updated > 0) {
          setPbPlaying(false);
          const resolved = list
            .filter((t) => t.exitDate && t.status !== "OPEN" && t.status !== "PENDING")
            .sort((a, b) => (b.exitDate || "").localeCompare(a.exitDate || ""))
            .slice(0, d.updated)
            .map((t) => `${t.symbol.replace(".NS", "")} ${t.status === "TARGET_HIT" ? "🎯 TARGET" : t.status === "SL_HIT" ? "🛑 SL" : "exit"} (${t.returnPct >= 0 ? "+" : ""}${t.returnPct}%)`)
            .join(", ");
          setPbPauseMsg(`⏸ Auto-paused — ${resolved}. Details "My Trades" tab mein.`);
        }
      })
      .catch(() => { /* watchdog is best-effort; the My Trades tab re-checks anyway */ })
      .finally(() => { pbCheckBusy.current = false; });
  }, [pbOn, pbDate, pbOpenCount]);

  // --- Period P&L Summary ---
  const [showPnl, setShowPnl] = useState(false);
  const [allTradesData, setAllTradesData] = useState<any[] | null>(null);
  const [pnlFrom, setPnlFrom] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [pnlTo, setPnlTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [pnlScope, setPnlScope] = useState<"tab" | "all">("all");
  useEffect(() => {
    if (showPnl && allTradesData === null) {
      fetch(`/cache/alltrades.json?t=${Date.now()}`)
        .then((r) => {
          const isJson = r.headers.get("content-type")?.includes("application/json");
          if (!r.ok || !isJson) throw new Error("not json");
          return r.json();
        })
        .then(setAllTradesData)
        .catch(() => setAllTradesData([]));
    }
  }, [showPnl, allTradesData]);
  const pnl = useMemo(() => {
    if (!allTradesData) return null;
    const mod = `m${tab}`;
    const scoped = allTradesData.filter(
      (t) => (pnlScope === "all" || t.mod === mod) && t.e >= pnlFrom && t.e <= pnlTo
    );
    const n = scoped.length;
    const wins = scoped.filter((t) => t.w).length;
    const sum = scoped.reduce((a, t) => a + t.r, 0);
    return {
      n, wins, losses: n - wins,
      wr: n ? Math.round((100 * wins) / n) : 0,
      sum, avg: n ? sum / n : 0,
      best: n ? Math.max(...scoped.map((t) => t.r)) : 0,
      worst: n ? Math.min(...scoped.map((t) => t.r)) : 0,
    };
  }, [allTradesData, tab, pnlScope, pnlFrom, pnlTo]);

  // Scanning engine states
  const [scanStatus, setScanStatus] = useState<{
    isScanning: boolean;
    progress: number;
    scanned: number;
    currentSymbol: string;
    passedCount: number;
    logs: string[];
  }>({
    isScanning: false,
    progress: 0,
    scanned: 0,
    currentSymbol: "",
    passedCount: 0,
    logs: []
  });

  const startScanning = async () => {
    try {
      const res = await fetch("/api/scan/start", { method: "POST" });
      const data = await res.json();
      if (data.status === "started" || data.status === "already_running") {
        setScanStatus(prev => ({ ...prev, isScanning: true }));
      }
    } catch (e) {
      console.error("Failed to start scan", e);
    }
  };

  // --- One-click "Scan & Publish" (LOCAL DEV ONLY) ---
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState("");
  const publishAfterScan = useRef(false); // ref avoids stale closure inside the polling effect

  const publishCache = async () => {
    setPublishing(true);
    setPublishMsg("Publishing to git…");
    try {
      const r = await fetch("/api/publish", { method: "POST" });
      const d = await r.json();
      setPublishMsg(d.ok ? "✅ Published — now redeploy on AI Studio" : "❌ " + (d.output || "publish failed"));
    } catch (e) {
      setPublishMsg("❌ publish request failed");
    } finally {
      setPublishing(false);
    }
  };

  const scanAndPublish = () => {
    setPublishMsg("");
    publishAfterScan.current = true;
    startScanning(); // scan first; the polling effect calls publishCache() when it finishes
  };

  const fetchMeta = (): Promise<Meta> =>
    fetch(`/api/meta?t=${Date.now()}`)
      .then((r) => {
        const isJson = r.headers.get("content-type")?.includes("application/json");
        if (!r.ok || !isJson) throw new Error("api down");
        return r.json();
      })
      .catch(() =>
        fetch(`/cache/meta.json?t=${Date.now()}`)
          .then((r) => {
            const isJson = r.headers.get("content-type")?.includes("application/json");
            if (!r.ok || !isJson) throw new Error("no cache");
            return r.json();
          })
      );

  const fetchModule = (n: number): Promise<LedgerRow[]> =>
    fetch(`/api/module/${n}?t=${Date.now()}`)
      .then((r) => {
        const isJson = r.headers.get("content-type")?.includes("application/json");
        if (!r.ok || !isJson) throw new Error("api down");
        return r.json();
      })
      .then((d) => (Array.isArray(d) ? d : Array.isArray(d.rows) ? d.rows : []))
      .catch(() =>
        fetch(`/cache/module${n}.json?t=${Date.now()}`)
          .then((r) => {
            const isJson = r.headers.get("content-type")?.includes("application/json");
            if (!r.ok || !isJson) throw new Error("no cache");
            return r.json();
          })
          .then((d) => (Array.isArray(d) ? d : []))
      );

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => setMeta({ needsScan: true }));
  }, []);

  useEffect(() => {
    if (tab === 5) { setRows([]); setLoading(false); return; } // journal tab has no standard module cache
    setLoading(true);
    fetchModule(tab)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [tab]);

  // Polling loop for active scans
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    let failCount = 0;
    if (scanStatus.isScanning) {
      interval = setInterval(() => {
        fetch("/api/scan/status")
          .then(res => res.json())
          .then(data => {
            failCount = 0; // reset on success
            setScanStatus({
              isScanning: data.isScanning,
              progress: data.progress,
              scanned: data.scanned,
              currentSymbol: data.currentSymbol,
              passedCount: data.passedCount,
              logs: data.logs || []
            });
            if (!data.isScanning && data.progress === 100) {
              fetchMeta().then(setMeta).catch(() => {});
              fetchModule(tab).then(setRows).catch(() => {});
              setAllTradesData(null);
              if (publishAfterScan.current) {
                publishAfterScan.current = false;
                publishCache();
              }
            }
            // Scan finished but progress not 100 — server restarted mid-scan
            if (!data.isScanning && data.progress < 100) {
              fetchMeta().then(setMeta).catch(() => {});
              fetchModule(tab).then(setRows).catch(() => {});
            }
          })
          .catch(err => {
            failCount++;
            console.error("Error polling scan status", err);
            // After 10 consecutive failures (5 seconds), assume server restarted — stop polling
            if (failCount >= 10) {
              setScanStatus(prev => ({ ...prev, isScanning: false, progress: 0 }));
              fetchMeta().then(setMeta).catch(() => {});
            }
          });
      }, 500);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [scanStatus.isScanning, tab]);

  // Reset filter/sort state when changing tabs
  useEffect(() => {
    setSearchQuery("");
    setLiveOnly(tab === 6);
    setSortField(null);
    setSortAsc(false);
  }, [tab]);

  const handleSort = (field: keyof LedgerRow) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const filteredAndSortedRows = useMemo(() => {
    const sourceRows: LedgerRow[] = pbOn ? ((pbSnap?.["module" + tab] as LedgerRow[]) ?? []) : rows;
    let result = [...sourceRows];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (r) =>
          r.symbol.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          r.strategyLabel.toLowerCase().includes(q)
      );
    }
    if (liveOnly) {
      result = result.filter((r) => r.liveSignal);
    }
    // M6 tab: sector toggle — Banks+Pharma+Power only when enabled
    if (tab === 6 && m6SectorFilter) {
      result = result.filter((r) => (r as any).inTargetSector === true);
    }
    if (sortField) {
      result.sort((a, b) => {
        const valA = a[sortField];
        const valB = b[sortField];
        if (valA === null || valA === undefined) return sortAsc ? -1 : 1;
        if (valB === null || valB === undefined) return sortAsc ? 1 : -1;
        if (typeof valA === "number" && typeof valB === "number") {
          return sortAsc ? valA - valB : valB - valA;
        }
        if (typeof valA === "boolean" && typeof valB === "boolean") {
          return sortAsc ? (valA ? 1 : -1) - (valB ? 1 : -1) : (valB ? 1 : -1) - (valA ? 1 : -1);
        }
        const strA = String(valA).toLowerCase();
        const strB = String(valB).toLowerCase();
        if (strA < strB) return sortAsc ? -1 : 1;
        if (strA > strB) return sortAsc ? 1 : -1;
        return 0;
      });
    }
    return result;
  }, [rows, searchQuery, liveOnly, sortField, sortAsc, pbOn, pbSnap, tab, m6SectorFilter]);

  const g = meta?.gate;
  const needsScan = meta?.needsScan && !pbOn; // playback has its own data source
  const effCounts = pbOn ? pbSnap?.counts : meta?.counts;
  const sourceRowsLen = pbOn ? ((pbSnap?.["module" + tab] as LedgerRow[] | undefined)?.length ?? 0) : rows.length;
  const pbIdx = pbOn && pbDate ? pbAxis.indexOf(pbDate) : -1;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="mark">
            edge<span className="dot">.</span>ledger
          </span>
          <span className="sub">Nifty 500 · Full-History Backtest · Gross Returns</span>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {import.meta.env.DEV && !pbOn && (
            <button 
              type="button"
              className="flex items-center gap-2 bg-gradient-to-r from-[#fbbf24] to-[#d97706] text-[#080b11] font-extrabold px-4.5 py-2.5 rounded-lg text-sm transition-all hover:scale-[1.03] cursor-pointer hover:shadow-[0_4px_15px_rgba(251,191,36,0.35)] active:scale-[0.97]"
              onClick={startScanning}
              disabled={scanStatus.isScanning}
            >
              <span className="flex h-2.5 w-2.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-black opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-black"></span>
              </span>
              Fetch Fresh Data
            </button>
          )}
          {import.meta.env.DEV && !pbOn && (
            <button
              type="button"
              className="flex items-center gap-2 bg-[#151b27] border border-[#fbbf24]/40 text-[#fbbf24] font-bold px-4 py-2.5 rounded-lg text-sm transition-all hover:bg-[#1b2230] cursor-pointer active:scale-[0.97] disabled:opacity-50"
              onClick={scanAndPublish}
              disabled={scanStatus.isScanning || publishing}
            >
              {scanStatus.isScanning ? "Scanning…" : publishing ? "Publishing…" : "🔄 Scan & Publish"}
            </button>
          )}
          {import.meta.env.DEV && publishMsg && (
            <span className="text-xs text-[#8e9ba9] font-mono max-w-[260px] truncate" title={publishMsg}>{publishMsg}</span>
          )}
          {!pbOn && (
            <button
              type="button"
              className="flex items-center gap-2 bg-[#151b27] border border-[#10b981]/50 text-[#22c55e] font-bold px-4 py-2.5 rounded-lg text-sm transition-all hover:bg-[#1b2230] cursor-pointer active:scale-[0.97] disabled:opacity-50"
              onClick={startScanning}
              disabled={scanStatus.isScanning}
              title="Turant naya scan chalao — 500 stocks ka latest data fetch karke cache refresh karega (~25-30s lagega)"
            >
              {scanStatus.isScanning
                ? `⏳ Scanning… ${scanStatus.scanned}/500`
                : "🔄 Refresh Now"}
            </button>
          )}
          {!pbOn ? (
            <button
              type="button"
              className="flex items-center gap-2 bg-[#151b27] border border-[#a855f7]/50 text-[#c084fc] font-bold px-4 py-2.5 rounded-lg text-sm transition-all hover:bg-[#1b2230] cursor-pointer active:scale-[0.97]"
              onClick={enterPlayback}
              title="Time machine: dashboard ko kisi bhi past date pe le jao"
            >
              🕰 Playback
            </button>
          ) : (
            <button
              type="button"
              className="flex items-center gap-2 bg-gradient-to-r from-[#a855f7] to-[#7c3aed] text-white font-extrabold px-4 py-2.5 rounded-lg text-sm transition-all hover:scale-[1.03] cursor-pointer active:scale-[0.97]"
              onClick={exitPlayback}
            >
              ⏹ Return to Today
            </button>
          )}
          {pbErr && !pbOn && <span className="text-xs text-[#ef4444] font-mono max-w-[280px]">{pbErr}</span>}
          <div className="gatestamp">
            <span className="gate-label">STRICT GATE</span>
            <span className="gate-rules">
              Win &gt; {g ? g.minWinRate * 100 : 60}% &amp; PF &gt; {g?.strict?.minProfitFactor ?? g?.minProfitFactor ?? 2.5}
            </span>
          </div>
        </div>
      </header>

      {/* 🕰 TIME MACHINE control strip */}
      {pbOn && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", padding: "10px 14px", margin: "0 0 14px", borderRadius: "10px", background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.45)", fontFamily: "monospace", fontSize: "13px" }}>
          <span style={{ fontWeight: 800, color: "#c084fc", letterSpacing: "0.04em" }}>🕰 PLAYBACK MODE</span>
          <input
            type="date"
            value={pbDate || ""}
            min={pbAxis[60] || pbAxis[0]}
            max={pbAxis[pbAxis.length - 1]}
            onChange={(e) => { setPbPlaying(false); setPbDate(snapToAxis(e.target.value)); }}
            style={{ background: "#0f141c", border: "1px solid #2a3342", color: "#e6edf5", borderRadius: "6px", padding: "5px 9px", fontFamily: "monospace" }}
          />
          <button className="toggle-filter-btn" onClick={() => { setPbPlaying(false); pbStep(-1); }} title="Ek trading din peeche">⏮ Prev</button>
          <button className="toggle-filter-btn" onClick={() => { setPbPlaying(false); pbStep(1); }} title="Ek trading din aage">Next ⏭</button>
          <button
            className="toggle-filter-btn"
            onClick={() => { setPbPauseMsg(""); setPbPlaying(!pbPlaying); }}
            style={{ background: pbPlaying ? "rgba(168,85,247,0.25)" : undefined, borderColor: "rgba(168,85,247,0.5)", color: "#c084fc", fontWeight: 700 }}
          >
            {pbPlaying ? "⏸ Pause" : "▶ Auto-play"}
          </button>
          <select
            value={pbSpeedMs}
            onChange={(e) => setPbSpeedMs(Number(e.target.value))}
            style={{ background: "#0f141c", border: "1px solid #2a3342", color: "#e6edf5", borderRadius: "6px", padding: "5px 8px", fontFamily: "monospace" }}
            title="Auto-play speed"
          >
            <option value={2000}>🐢 Slow (2s/din)</option>
            <option value={1200}>▶ Normal (1.2s/din)</option>
            <option value={500}>⏩ Fast (0.5s/din)</option>
            <option value={150}>🚀 Turbo (0.15s/din)</option>
          </select>
          <span style={{ color: "#8e9ba9" }}>
            Din {pbIdx >= 0 ? pbIdx + 1 : "—"} / {pbAxis.length}
            {pbLoading && <span style={{ marginLeft: "8px", color: "#c084fc" }}>⏳</span>}
          </span>
          {pbErr && <span style={{ color: "#ef4444" }}>{pbErr}</span>}
          {pbPauseMsg && <span style={{ color: "#fbbf24", fontWeight: 700 }}>{pbPauseMsg}</span>}
          <span style={{ flexBasis: "100%", color: "#576575", fontSize: "11px" }}>
            Dashboard bilkul waisa hai jaisa {pbDate} ke close pe hota — us date ke baad ka koi data engine ko nahi dikhta. Practice trades "My Trades" tab mein alag journal mein track hote hain.
          </span>
        </div>
      )}

      {meta && !needsScan && (
        <section className="stats-dashboard grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="stat-card">
            <span className="stat-label">Universe Size</span>
            <span className="stat-value">{meta.universeCount} Symbols</span>
            <div className="stat-progress">
              <span className="stat-progress-fill" style={{ width: "100%" }} />
            </div>
            <span className="stat-sub">Nifty 500 universe loaded</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Scanned Data</span>
            <span className="stat-value">
              {Math.min(meta.withData ?? 0, meta.universeCount ?? 500)} <span className="stat-value-sub">/ {meta.universeCount ?? 500}</span>
            </span>
            <div className="stat-progress">
              <span
                className="stat-progress-fill success"
                style={{ width: `${((meta.withData || 0) / (meta.scanned || 1)) * 100}%` }}
              />
            </div>
            <span className="stat-sub">Stocks with historical records</span>
          </div>
          <div className="stat-card highlights">
            <span className="stat-label">Passed Gates</span>
            <span className="stat-value text-gold">
              {pbOn ? ((effCounts?.module1 || 0) + (effCounts?.module6 || 0) + (effCounts?.module7 || 0)) : (meta.passed ?? ((effCounts?.module1 || 0) + (effCounts?.module6 || 0) + (effCounts?.module7 || 0)))} <span className="stat-value-sub">Total</span>
            </span>
            <div className="stat-split-bar flex h-2 rounded-full overflow-hidden mt-1.5">
              <span className="stat-split-1 bg-amber-500" style={{ width: `${((effCounts?.module1 || 0) / (((effCounts?.module1 || 0) + (effCounts?.module6 || 0) + (effCounts?.module7 || 0)) || 1)) * 100}%` }} />
              <div className="stat-split-6 bg-cyan-400" style={{ width: `${((effCounts?.module6 || 0) / (((effCounts?.module1 || 0) + (effCounts?.module6 || 0) + (effCounts?.module7 || 0)) || 1)) * 100}%` }} />
              <div className="stat-split-7 bg-emerald-500" style={{ width: `${((effCounts?.module7 || 0) / (((effCounts?.module1 || 0) + (effCounts?.module6 || 0) + (effCounts?.module7 || 0)) || 1)) * 100}%` }} />
            </div>
            <span className="stat-sub text-xs">
              StochRSI: {effCounts?.module1 ?? 0} · ConnorsRSI: {effCounts?.module6 ?? 0} · Turtle Soup: {effCounts?.module7 ?? 0}
            </span>
          </div>
        </section>
      )}

      {pbOn ? (
        <div className="last-updated-bar" style={{ borderColor: "rgba(168,85,247,0.4)", color: "#c084fc" }}>
          <span className="pulse-indicator" style={{ background: "#a855f7" }} />
          Time machine active — dashboard as of {pbDate} (close). Aaj ke data pe wapas jaane ke liye "Return to Today" dabao.
        </div>
      ) : meta && meta.generatedAt && (
        <div className="last-updated-bar">
          <span className="pulse-indicator" />
          Data generated at: {new Date(meta.generatedAt).toLocaleString()} ({meta.elapsedSec}s compute time)
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={"tab" + (tab === t.n ? " active" : "")}
            onClick={() => setTab(t.n)}
          >
            <span className="num">{String(t.n).padStart(2, "0")}</span>
            <span className="tab-text">{t.label}</span>
            {t.n === 5 ? (
              (pbOn ? pbJournalCount : journalCount) !== null && <span className="count">{pbOn ? pbJournalCount : journalCount}</span>
            ) : (
              effCounts && (
                <span className="count">{(effCounts as any)["module" + t.n] ?? 0}</span>
              )
            )}
          </button>
        ))}
      </nav>

      <section className="panel">
        <div className="panel-head-group">
          <div className="panel-info">
            <h2>{TABS.find(t => t.n === tab)?.label}</h2>
            <p>{DESC[tab]}</p>
          </div>
          {!needsScan && sourceRowsLen > 0 && (
            <div className="controls-row flex flex-wrap gap-3 items-center justify-between">
              <div className="search-box">
                <span className="search-icon">🔍</span>
                <input
                  type="text"
                  placeholder="Search stock symbol, name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="clear-btn" onClick={() => setSearchQuery("")}>
                    ✕
                  </button>
                )}
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                <button
                  className={`toggle-filter-btn ${liveOnly ? "active" : ""}`}
                  onClick={() => setLiveOnly(!liveOnly)}
                >
                  <span className="toggle-dot" />
                  LIVE Signals Only
                </button>
                {tab === 6 && (
                  <button
                    className={`toggle-filter-btn ${m6SectorFilter ? "active" : ""}`}
                    onClick={() => setM6SectorFilter(!m6SectorFilter)}
                    title={m6SectorFilter ? "Sector filter ON: sirf Banks, Pharma, Power — OOS PF 2.59, Win 68%" : "Sector filter OFF: saare sectors — OOS PF 1.34, Win 59%"}
                  >
                    <span className="toggle-dot" />
                    {m6SectorFilter ? "🏦 Banks • Pharma • Power" : "🌐 All Sectors"}
                  </button>
                )}
                <div className="history-date-box" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#8e9ba9" }}>
                  <span>Signals since</span>
                  <input
                    type="date"
                    value={historyStart}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setHistoryStart(e.target.value)}
                    style={{ background: "#0f141c", border: "1px solid #212836", color: "#e6edf5", borderRadius: "6px", padding: "4px 8px", fontFamily: "monospace" }}
                  />
                </div>
                <div className="rows-count-badge bg-[#151b27] px-2.5 py-1 rounded-md text-xs border border-slate-800 text-[#8e9ba9] font-mono">
                  Showing {filteredAndSortedRows.length} of {sourceRowsLen}
                </div>
              </div>
            </div>
          )}
          {!needsScan && !pbOn && rows.length > 0 && (
            <div style={{ padding: "4px 0 12px" }}>
              <button className="toggle-filter-btn" onClick={() => setShowPnl(!showPnl)} style={{ fontSize: "12px" }}>
                📊 Period P&L Summary {showPnl ? "▲" : "▼"}
              </button>
              {showPnl && (
                <div style={{ marginTop: "10px", padding: "12px 14px", borderRadius: "8px", background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.25)", fontFamily: "monospace", fontSize: "13px", color: "#c9d3df" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "10px" }}>
                    <label>From <input type="date" value={pnlFrom} onChange={(e) => setPnlFrom(e.target.value)} style={{ background: "#0f141c", color: "#e6edf5", border: "1px solid #212836", borderRadius: "6px", padding: "4px 8px", fontFamily: "monospace" }} /></label>
                    <label>To <input type="date" value={pnlTo} onChange={(e) => setPnlTo(e.target.value)} style={{ background: "#0f141c", color: "#e6edf5", border: "1px solid #212836", borderRadius: "6px", padding: "4px 8px", fontFamily: "monospace" }} /></label>
                    <button className="toggle-filter-btn" onClick={() => setPnlScope("tab")} style={{ opacity: pnlScope === "tab" ? 1 : 0.5 }}>This module</button>
                    <button className="toggle-filter-btn" onClick={() => setPnlScope("all")} style={{ opacity: pnlScope === "all" ? 1 : 0.5 }}>All 4 modules</button>
                  </div>
                  {allTradesData === null ? (
                    <div style={{ color: "#8e9ba9" }}>Loading trades…</div>
                  ) : pnl && pnl.n > 0 ? (
                    <div>
                      <div style={{ fontSize: "14px", marginBottom: "6px" }}>
                        <strong>{pnl.n}</strong> trades entered ({pnlScope === "all" ? "all 4 modules" : TABS.find(t => t.n === tab)?.label}):{" "}
                        <span className="text-success">{pnl.wins} win</span> · <span className="text-danger">{pnl.losses} loss</span> · <strong>{pnl.wr}% win rate</strong>
                      </div>
                      <div>
                        Sum of per-trade returns: <strong className={pnl.sum >= 0 ? "text-success" : "text-danger"}>{pnl.sum >= 0 ? "+" : ""}{pnl.sum.toFixed(1)}%</strong>
                        {"  ·  "}Avg/trade: <strong>{pnl.avg >= 0 ? "+" : ""}{pnl.avg.toFixed(2)}%</strong>
                        {"  ·  "}Best: <span className="text-success">+{pnl.best.toFixed(1)}%</span>
                        {"  ·  "}Worst: <span className="text-danger">{pnl.worst.toFixed(1)}%</span>
                      </div>
                      <div style={{ color: "#8e9ba9", fontSize: "11px", marginTop: "8px" }}>
                        Note: “Sum of returns” assumes 1 equal unit per trade — NOT a real compounded portfolio return (trades overlap; ignores position sizing, costs, slippage). Rough edge tally, not account P&L.
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: "#8e9ba9" }}>No trades entered between {pnlFrom} and {pnlTo}.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {tab === 5 ? (
          <MyTrades
            key={pbOn ? "pb" : "live"}
            mode={pbOn ? "playback" : "live"}
            asOfDate={pbOn ? (pbDate || undefined) : undefined}
            onCountChange={pbOn ? setPbJournalCount : setJournalCount}
          />
        ) : tab === 6 ? (
          pbOn && !pbSnap ? (
            <div className="state">
              <div className="spinner" />
              {pbErr ? pbErr : `Building the dashboard as of ${pbDate}…`}
            </div>
          ) : (
            <Ledger
              rows={filteredAndSortedRows}
              onSort={handleSort}
              sortField={sortField}
              sortAsc={sortAsc}
              strictHighlight={false}
              showStrategy={true}
              historyStart={historyStart}
            />
          )
        ) : pbOn && !pbSnap ? (
          <div className="state">
            <div className="spinner" />
            {pbErr ? pbErr : `Building the dashboard as of ${pbDate}…`}
          </div>
        ) : loading && !pbOn ? (
          <div className="state">
            <div className="spinner" />
            Loading ledger database...
          </div>
        ) : needsScan ? (
          <div className="state scan-cta flex flex-col items-center justify-center p-12 text-center">
            <div className="text-xl font-bold text-white mb-2">
              {meta?.stale ? "Cache outdated — rebuild required" : "No analysis cache found"}
            </div>
            <p className="text-sm text-[#8e9ba9] max-w-md mb-6">
              {meta?.stale
                ? `Your cached data was built with older scan rules and no longer matches the current gate (${meta.reason || ""}). Rebuild to refresh.`
                : "Run the Nifty 500 multi-strategy scanner now to build the high-fidelity backtest database."}
            </p>
            {import.meta.env.DEV ? (
              <>
                <button 
                  type="button"
                  className="bg-gradient-to-r from-[#fbbf24] to-[#d97706] text-[#080b11] font-extrabold px-6 py-3 rounded-lg text-base shadow-[0_4px_16px_rgba(251,191,36,0.3)] hover:scale-[1.03] transition-all cursor-pointer mb-6"
                  onClick={startScanning}
                >
                  🚀 Run Multi-Strategy Scan Now
                </button>
                <div className="commands-box border border-[#212836] bg-[#0f141c]/40 p-4 rounded-lg max-w-md w-full text-left font-mono text-xs text-[#8e9ba9]">
                  <div className="mb-2">
                    <span className="text-[#fbbf24]"># Or execute manually in terminal:</span>
                  </div>
                  <div className="flex justify-between items-center mb-1">
                    <span>Fast demo scan:</span>
                    <code className="bg-[#151b27] px-2 py-0.5 rounded text-white font-semibold">npm run scan:demo</code>
                  </div>
                  <div className="flex justify-between items-center">
                    <span>Full-history scan:</span>
                    <code className="bg-[#151b27] px-2 py-0.5 rounded text-white font-semibold">npm run scan</code>
                  </div>
                </div>
              </>
            ) : (
              <div className="commands-box border border-[#212836] bg-[#0f141c]/40 p-4 rounded-lg max-w-md w-full text-left font-mono text-xs text-[#8e9ba9]">
                <div className="mb-2">
                  <span className="text-[#fbbf24]"># This deployment serves a pre-built cache.</span>
                </div>
                <div className="mb-1">Generate &amp; commit it locally, then redeploy:</div>
                <div className="flex justify-between items-center">
                  <span>Build cache:</span>
                  <code className="bg-[#151b27] px-2 py-0.5 rounded text-white font-semibold">npm run scan</code>
                </div>
              </div>
            )}
          </div>
        ) : filteredAndSortedRows.length === 0 ? (
          <div className="state empty-state">
            {rows.length === 0 ? (
              <>
                <div className="big">{pbOn ? `${pbDate} ko koi stock gate pass nahi karta tha` : "Zero stocks cleared the gate"}</div>
                <p>
                  Applying gate constraints: Win Rate &ge; {g ? g.minWinRate * 100 : 60}% and Profit Factor &ge;{" "}
                  {g ? g.minProfitFactor : 2} with {g ? g.minOosTrades : 10}+ minimum trades.
                </p>
              </>
            ) : (
              <>
                <div className="big">No matches in this view</div>
                <p>
                  {rows.length} stock{rows.length === 1 ? "" : "s"} cleared the gate, but none match your current filters
                  {liveOnly ? " — no LIVE entry signal in the last 5 sessions" : ""}. Clear filters to see them.
                </p>
              </>
            )}
            {(searchQuery || liveOnly) && (
              <button
                className="reset-filters-btn"
                onClick={() => {
                  setSearchQuery("");
                  setLiveOnly(false);
                }}
              >
                Reset Filters
              </button>
            )}
          </div>
        ) : (
          <Ledger
            rows={filteredAndSortedRows}
              showStrategy={true}
            sortField={sortField}
            sortAsc={sortAsc}
            onSort={handleSort}
            historyStart={historyStart}
            strictHighlight={false}
            playbackDate={pbOn ? pbDate : null}
            onTradeTaken={() => (pbOn ? (setPbJournalCount((c) => (c ?? 0) + 1), setPbOpenCount((c) => c + 1)) : setJournalCount((c) => (c ?? 0) + 1))}
          />
        )}

        {/* Module 3 breadth */}
      </section>

      {/* Real-time Scan Terminal overlay */}
      {scanStatus.isScanning && (
        <div className="fixed inset-0 bg-[#080b11]/80 backdrop-blur-md z-[1000] flex items-center justify-center p-4">
          <div className="bg-[#0f141c] border border-[#212836] rounded-xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
            {/* Modal Header */}
            <div className="p-4 border-b border-[#181f2c] flex justify-between items-center bg-[#151b27]">
              <div className="flex items-center gap-3">
                <span className="flex h-3 w-3 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#fbbf24] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-[#fbbf24]"></span>
                </span>
                <span className="font-bold tracking-tight text-white text-base">High-Fidelity Engine Scanning...</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-[#8e9ba9] bg-[#212836] px-2.5 py-1 rounded">
                  Scanned: {scanStatus.scanned}
                </span>
                <button
                  onClick={() => setScanStatus(prev => ({ ...prev, isScanning: false }))}
                  title="Hide overlay — scan continues in background"
                  style={{ background: "transparent", border: "1px solid #2a3342", color: "#8e9ba9", borderRadius: "6px", padding: "4px 10px", fontSize: "11px", fontFamily: "monospace", cursor: "pointer" }}
                >
                  ✕ Hide
                </button>
              </div>
            </div>

            {/* Progress Panel */}
            <div className="p-5 border-b border-[#181f2c] bg-[#111622]/40">
              <div className="flex justify-between text-sm mb-2 font-medium">
                <span className="text-[#8e9ba9]">Processing: <strong className="text-white font-semibold">{scanStatus.currentSymbol}</strong></span>
                <span className="text-[#fbbf24] font-mono font-bold">{scanStatus.progress}%</span>
              </div>
              <div className="w-full bg-[#181f2c] h-3.5 rounded-full overflow-hidden p-[2px]">
                <div 
                  className="bg-gradient-to-r from-[#fbbf24] to-[#10b981] h-full rounded-full transition-all duration-300 shadow-[0_0_12px_rgba(251,191,36,0.3)]"
                  style={{ width: `${scanStatus.progress}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-[#576575] mt-3 font-mono">
                <span>Indicators: 10 technical metrics/stock</span>
                <span>Cleared Gates: <strong className="text-[#10b981]">{scanStatus.passedCount} stocks</strong></span>
              </div>
            </div>

            {/* Terminal Console */}
            <div className="flex-1 p-4 overflow-y-auto bg-[#05070a] font-mono text-xs text-[#10b981] min-h-[250px] max-h-[350px] leading-relaxed flex flex-col-reverse rounded-b-lg">
              <div>
                {scanStatus.logs.slice().reverse().map((logLine, idx) => (
                  <div key={idx} className={`py-0.5 ${logLine.includes("[AI OPTIMIZER PASS]") ? "text-[#fbbf24] font-bold" : logLine.includes("[ROUNDING") ? "text-[#3b82f6] font-bold" : logLine.includes("✅") ? "text-[#10b981] font-bold" : "text-[#8e9ba9]"}`}>
                    <span className="text-[#576575] mr-2">[{new Date().toLocaleTimeString()}]</span>
                    {logLine}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConditionCard({ data }: { data: Bucketed }) {
  const max = Math.max(1, ...data.buckets.map((b) => b.winRatePct));
  return (
    <div className="card">
      <h4>Best conditions · {data.label}</h4>
      <div className="bars-container">
        {data.buckets.map((b) => (
          <div className="bar-row" key={b.range}>
            <span className="bar-label">{b.range}</span>
            <div className="bar-track">
              <span
                className="bar-fill success"
                style={{ width: `${(b.winRatePct / max) * 100}%` }}
              />
            </div>
            <span className="bar-val">
              <strong>{b.winRatePct}%</strong> win (n{b.trades})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
