import React, { useState, useEffect, useRef } from "react";

interface SchemeAgg {
  key: string;
  label: string;
  trades: number;
  winRatePct: number;
  profitFactor: number;
  avgReturnPct: number;
  expectancyPct: number;
  avgWinPct: number;
  avgLossPct: number;
  maxDrawdownPct: number;
  avgPlannedRR: number | null;
}

interface StrategyResult {
  id: string;
  label: string;
  schemes: SchemeAgg[];
  best: { key: string; label: string; reason: string } | null;
}

interface CompareResult {
  ok: boolean;
  universeRequested: number;
  universeUsed: number;
  skipped: string[];
  elapsedSec: number;
  strategies: StrategyResult[];
  note: string;
  error?: string;
}

interface JobStatus {
  running: boolean;
  done: number;
  total: number;
  currentSymbol: string;
  elapsedSec: number;
  hasResult: boolean;
  error: string | null;
}

export function ExitSchemeComparison() {
  const [data, setData] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState<number>(30); // sensible default for rapid view
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const startPolling = () => {
    stopPolling();
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/compare-sl/status?t=${Date.now()}`);
        if (!res.ok) {
          throw new Error(`Server returned error status ${res.status}`);
        }
        const s: JobStatus = await res.json();
        setStatus(s);

        if (s.error) {
          setError(s.error);
          setLoading(false);
          stopPolling();
          return;
        }

        if (s.hasResult) {
          const rRes = await fetch(`/api/compare-sl/result?t=${Date.now()}`);
          if (!rRes.ok) {
            throw new Error(`Server returned error status ${rRes.status}`);
          }
          const rData = await rRes.json();
          if (rData.ok) {
            setData(rData);
            setError(null);
          } else {
            setError(rData.error || "Failed to load result.");
          }
          setLoading(false);
          stopPolling();
          return;
        }

        if (!s.running && !s.hasResult) {
          setLoading(false);
          stopPolling();
        }
      } catch (e: any) {
        setError(e.message || String(e));
        setLoading(false);
        stopPolling();
      }
    }, 1000);
  };

  const runComparison = async (useLimit: boolean) => {
    setLoading(true);
    setError(null);
    setData(null);
    setStatus(null);
    try {
      const startUrl = useLimit ? `/api/compare-sl/start?limit=${limit}&t=${Date.now()}` : `/api/compare-sl/start?t=${Date.now()}`;
      const startRes = await fetch(startUrl);
      if (!startRes.ok) {
        throw new Error(`Server returned error status ${startRes.status}`);
      }
      const startData = await startRes.json();
      if (!startData.ok) {
        throw new Error(startData.error || "Failed to start the backtest comparison.");
      }
      startPolling();
    } catch (e: any) {
      setError(e.message || String(e));
      setLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const checkActiveJob = async () => {
      try {
        const res = await fetch(`/api/compare-sl/status?t=${Date.now()}`);
        if (!res.ok) return;
        const s: JobStatus = await res.json();
        if (!isMounted) return;
        setStatus(s);

        if (s.running) {
          setLoading(true);
          startPolling();
        } else if (s.hasResult) {
          const rRes = await fetch(`/api/compare-sl/result?t=${Date.now()}`);
          if (!rRes.ok) return;
          const rData = await rRes.json();
          if (isMounted && rData.ok) {
            setData(rData);
          }
        }
      } catch (e) {
        // ignore background status check error
      }
    };
    checkActiveJob();

    return () => {
      isMounted = false;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  return (
    <div className="exit-comparison-module p-1" id="exit-comparison-module">
      {/* Configuration Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 mb-6 rounded-xl border border-slate-800 bg-[#0f141c]/40" id="controls-container">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[#8e9ba9] font-mono">Universe Limit</span>
            <div className="flex items-center gap-2">
              <select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="bg-[#151b27] border border-slate-800 text-[#e6edf5] text-xs rounded-lg px-3 py-2 font-mono outline-none focus:border-[#fbbf24]/50"
                disabled={loading}
              >
                <option value={15}>Top 15 Stocks (Fast)</option>
                <option value={30}>Top 30 Stocks (Recommended)</option>
                <option value={50}>Top 50 Stocks (Standard)</option>
                <option value={100}>Top 100 Stocks (Thorough)</option>
                <option value={0}>Full Universe (Nifty 500)</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-[#8e9ba9] max-w-sm mt-4">
            Compiling and simulating trades in parallel. Scanning uses locally cached candle histories first for instantaneous processing.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="flex items-center gap-2 bg-[#151b27] border border-[#fbbf24]/40 text-[#fbbf24] font-bold px-4 py-2.5 rounded-lg text-sm transition-all hover:bg-[#1b2230] cursor-pointer active:scale-[0.97] disabled:opacity-50"
            onClick={() => runComparison(true)}
            disabled={loading}
          >
            {loading ? "Simulating..." : "⚡ Quick Compare"}
          </button>
          <button
            type="button"
            className="flex items-center gap-2 bg-gradient-to-r from-[#fbbf24] to-[#d97706] text-[#080b11] font-extrabold px-5 py-2.5 rounded-lg text-sm transition-all hover:scale-[1.03] cursor-pointer hover:shadow-[0_4px_15px_rgba(251,191,36,0.3)] active:scale-[0.97] disabled:opacity-50"
            onClick={() => runComparison(false)}
            disabled={loading}
          >
            {loading ? "Simulating Full..." : "🚀 Run Full Comparison"}
          </button>
        </div>
      </div>

      {/* Loading Screen */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-12 text-center animate-pulse" id="loading-state">
          <div className="relative w-16 h-16 mb-6">
            <div className="absolute inset-0 border-4 border-[#fbbf24]/20 rounded-full" />
            <div className="absolute inset-0 border-4 border-[#fbbf24] border-t-transparent rounded-full animate-spin" />
          </div>
          <h3 className="text-white font-extrabold text-base mb-1.5 tracking-tight">
            Simulating 7 Exit Schemes... {status && status.total > 0 ? `(${status.done} / ${status.total})` : ""}
          </h3>
          {status && status.currentSymbol && (
            <div className="text-xs text-[#fbbf24] font-mono bg-[#fbbf24]/10 border border-[#fbbf24]/20 px-3 py-1.5 rounded-md mb-3 inline-block">
              ⚡ Processing: {status.currentSymbol}
            </div>
          )}
          <p className="text-[#8e9ba9] text-xs max-w-md font-mono leading-relaxed px-4">
            Parallel processing over Nifty historical records. Calculating ATR-multiplier stops, dynamic targets, and risk-to-reward boundaries. {status && status.elapsedSec > 0 ? `[Elapsed: ${status.elapsedSec}s]` : ""}
          </p>
        </div>
      )}

      {/* Error State */}
      {error && !loading && (
        <div className="p-4 border border-red-900 bg-red-950/20 text-red-400 rounded-lg text-sm font-mono" id="error-state">
          ❌ Comparison failed: {error}
          <div className="text-xs text-slate-500 mt-2">
            Tip: Make sure you have fetched fresh data in the app (the playback/cached files are needed).
          </div>
        </div>
      )}

      {/* Results Rendering */}
      {data && !loading && (
        <div className="space-y-8 animate-fadeIn" id="results-container">
          <div className="flex items-center justify-between text-xs font-mono text-[#8e9ba9] bg-[#0f141c]/30 px-4 py-2 rounded-lg border border-slate-800">
            <span>Universe Analyzed: <strong>{data.universeUsed}</strong> of {data.universeRequested} stocks</span>
            <span>Completed in <strong>{data.elapsedSec}s</strong></span>
          </div>

          {data.strategies.map((strat) => {
            const hasTrades = strat.schemes.some(s => s.trades > 0);
            return (
              <div key={strat.id} className="rounded-xl border border-slate-800 bg-[#0c1017] overflow-hidden" id={`strat-${strat.id}`}>
                {/* Strat Header */}
                <div className="p-4 bg-[#111622] border-b border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                  <div>
                    <h3 className="text-base font-bold text-white tracking-tight">{strat.label}</h3>
                    <p className="text-xs text-[#8e9ba9] mt-0.5">Identical entry signals — compared strictly on SL/TP parameters</p>
                  </div>
                  {strat.best && (
                    <span className="bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[11px] font-bold px-2.5 py-1 rounded">
                      💡 Recommended Exit: {strat.best.label}
                    </span>
                  )}
                </div>

                {/* Best Reason Alert */}
                {strat.best && (
                  <div className="px-4 py-3 bg-[#0d1520] border-b border-slate-800 text-xs text-amber-200 flex items-start gap-2.5 leading-relaxed font-sans">
                    <span className="text-amber-400 text-base leading-none">💡</span>
                    <div>
                      <span className="font-bold">Edge Verdict: </span>
                      {strat.best.reason}
                    </div>
                  </div>
                )}

                {/* Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse font-sans text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-[#8e9ba9] bg-[#090d12]/40">
                        <th className="p-3.5 font-semibold">Exit Scheme Description</th>
                        <th className="p-3.5 font-semibold text-right">Trades</th>
                        <th className="p-3.5 font-semibold text-right">Win Rate</th>
                        <th className="p-3.5 font-semibold text-right">Profit Factor</th>
                        <th className="p-3.5 font-semibold text-right">Avg Return</th>
                        <th className="p-3.5 font-semibold text-right">Expectancy</th>
                        <th className="p-3.5 font-semibold text-right">Max DD</th>
                        <th className="p-3.5 font-semibold text-right">Planned R:R</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {strat.schemes.map((sc) => {
                        const isBest = strat.best?.key === sc.key;
                        const isCurrent = sc.key === "IND";
                        return (
                          <tr
                            key={sc.key}
                            className={`transition-colors hover:bg-slate-800/10 ${
                              isBest
                                ? "bg-amber-500/[0.03] text-[#f59e0b]"
                                : isCurrent
                                ? "bg-slate-800/10 text-slate-300"
                                : "text-[#c9d3df]"
                            }`}
                          >
                            <td className="p-3.5 font-sans font-medium text-slate-200">
                              <div className="flex items-center gap-1.5">
                                {isBest && <span className="text-amber-500 font-bold" title="Highest Mathematical Expectancy">★</span>}
                                {isCurrent && <span className="text-[#8e9ba9] text-[10px] bg-slate-800 px-1.5 py-0.5 rounded mr-1">CURRENT</span>}
                                <span>{sc.label}</span>
                              </div>
                            </td>
                            <td className="p-3.5 text-right font-semibold">{sc.trades}</td>
                            <td className="p-3.5 text-right text-success">{sc.winRatePct}%</td>
                            <td className={`p-3.5 text-right font-bold ${sc.profitFactor >= 2 ? "text-[#10b981]" : sc.profitFactor >= 1 ? "text-[#fbbf24]" : "text-[#ef4444]"}`}>
                              {sc.profitFactor.toFixed(2)}
                            </td>
                            <td className={`p-3.5 text-right ${sc.avgReturnPct > 0 ? "text-success" : sc.avgReturnPct < 0 ? "text-danger" : ""}`}>
                              {sc.avgReturnPct > 0 ? "+" : ""}{sc.avgReturnPct}%
                            </td>
                            <td className={`p-3.5 text-right font-bold text-sm ${sc.expectancyPct > 0 ? "text-success" : sc.expectancyPct < 0 ? "text-danger" : ""}`}>
                              {sc.expectancyPct > 0 ? "+" : ""}{sc.expectancyPct}%
                            </td>
                            <td className="p-3.5 text-right text-danger">-{sc.maxDrawdownPct}%</td>
                            <td className="p-3.5 text-right text-[#8e9ba9]">
                              {sc.avgPlannedRR ? `${sc.avgPlannedRR}:1` : "Indicator-based"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

          <div className="text-xs text-[#576575] leading-relaxed p-4 bg-[#0a0d14] rounded-lg border border-slate-900 font-sans">
            <strong>Engine Note:</strong> {data.note}
          </div>
        </div>
      )}

      {/* Intro Instructions */}
      {!data && !loading && !error && (
        <div className="text-center py-12 p-6 rounded-xl border border-dashed border-slate-800 bg-[#0a0d14]/30" id="intro-state">
          <span className="text-4xl mb-3 block">📊</span>
          <h3 className="text-base font-bold text-white mb-2">Backtest 7 Strategic Exit Schemes</h3>
          <p className="text-[#8e9ba9] text-xs max-w-lg mx-auto mb-6 leading-relaxed">
            The standard dashboard uses dynamic indicator levels for trade exit targets, but is a fixed 8% Stop Loss or ATR-based multiplier more robust? Run the comparison to simulate 7 mathematical exit schemes net of 0.2% commission per trade.
          </p>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              className="bg-gradient-to-r from-[#fbbf24] to-[#d97706] text-[#080b11] font-extrabold px-6 py-2.5 rounded-lg text-sm transition-all hover:scale-[1.03] cursor-pointer hover:shadow-[0_4px_15px_rgba(251,191,36,0.3)] active:scale-[0.97]"
              onClick={() => runComparison(true)}
            >
              Simulate Active Universe (Fast)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
