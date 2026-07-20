import React, { useEffect, useState } from "react";

// ============================================================================
// DivergenceChart — modal: OHLC candlestick chart + RSI panel
//   - Pivot dots on ACTUAL high/low (not close) — visually correct
//   - Divergence trendlines connect real swing extremes
//   - Green = bullish div, Red = bearish div
//   - ▲/▼ = confirm bar (PIVOT_K=3 bars after pivot, no look-ahead)
// ============================================================================

interface ChartEvent {
  type: "bullish" | "bearish";
  confirmDate: string;
  p1: { x: number; d: string; price: number; rsi: number };
  p2: { x: number; d: string; price: number; rsi: number };
  confirmX: number;
}
interface ChartData {
  ok: boolean;
  symbol: string;
  dates: string[];
  closes: number[];
  highs: number[];
  lows: number[];
  opens?: number[];
  rsi: number[];
  events: ChartEvent[];
  error?: string;
}

const GREEN = "#22c55e", RED = "#ef4444", GRID = "#1b2230", TEXT = "#8e9ba9";
const BULL_C = "#22c55e", BEAR_C = "#ef4444", DOJI_C = "#8e9ba9";

export function DivergenceChart({ symbol, name, asOf, onClose }: {
  symbol: string; name?: string; asOf?: string | null; onClose: () => void;
}) {
  const [data, setData] = useState<ChartData | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`/api/divergence/chart?symbol=${encodeURIComponent(symbol)}${asOf ? `&asOf=${asOf}` : ""}&t=${Date.now()}`)
      .then(r => r.json())
      .then(d => d.ok ? setData(d) : setErr(d.error || "Chart load nahi hua"))
      .catch(() => setErr("Chart load nahi hua — server dekho"));
  }, [symbol, asOf]);

  const W = 960, PH = 320, RH = 160;
  const PADL = 62, PADR = 16, PADT = 20, PADB = 28, GAP = 36;
  const totalH = PADT + PH + GAP + RH + PADB;

  let body: React.ReactNode;

  if (err) {
    body = <div style={{ padding: 40, color: RED, fontFamily: "monospace" }}>❌ {err}</div>;
  } else if (!data) {
    body = <div style={{ padding: 40, color: TEXT, fontFamily: "monospace" }}>⏳ Chart ban raha hai…</div>;
  } else {
    const n = data.closes.length;
    if (n === 0) {
      body = <div style={{ padding: 40, color: TEXT, fontFamily: "monospace" }}>Koi data nahi mila.</div>;
    } else {
      // ── coordinate helpers ──────────────────────────────────────────────
      const barW = Math.max(1.5, Math.min(10, (W - PADL - PADR) / n - 1));
      const X = (i: number) => PADL + (i / Math.max(1, n - 1)) * (W - PADL - PADR);

      const pMin = Math.min(...data.lows)  * 0.992;
      const pMax = Math.max(...data.highs) * 1.008;
      const PY = (v: number) => PADT + (1 - (v - pMin) / (pMax - pMin)) * PH;

      const rTop = PADT + PH + GAP;
      const rMin = Math.max(0,   Math.min(...data.rsi.filter(v => v > 0)) - 5);
      const rMax = Math.min(100, Math.max(...data.rsi) + 5);
      const RY = (v: number) => rTop + (1 - (v - rMin) / (rMax - rMin)) * RH;

      // ── price grid ──────────────────────────────────────────────────────
      const pTicks = [0, 0.25, 0.5, 0.75, 1].map(f => pMin + f * (pMax - pMin));
      const rTicks = [30, 40, 50, 60, 70].filter(v => v >= rMin && v <= rMax);
      const dTicks = [0, 0.2, 0.4, 0.6, 0.8, 0.999].map(f => Math.floor(f * (n - 1)));

      // ── candlesticks ────────────────────────────────────────────────────
      const opens = data.opens && data.opens.length === n ? data.opens : data.closes.map((c, i) => i === 0 ? c : data.closes[i - 1]);
      const candles = data.closes.map((close, i) => {
        const open = opens[i], high = data.highs[i], low = data.lows[i];
        const bull = close >= open;
        const col = Math.abs(close - open) < 0.001 * close ? DOJI_C : bull ? BULL_C : BEAR_C;
        const bodyTop = PY(Math.max(open, close));
        const bodyBot = PY(Math.min(open, close));
        const bodyH = Math.max(1, bodyBot - bodyTop);
        const cx = X(i);
        return { cx, col, bull, bodyTop, bodyH, wickTop: PY(high), wickBot: PY(low) };
      });

      // ── RSI line ────────────────────────────────────────────────────────
      const rsiPath = data.rsi
        .map((v, i) => v > 0 ? `${i === 0 || data.rsi[i-1] <= 0 ? "M" : "L"}${X(i).toFixed(1)},${RY(v).toFixed(1)}` : null)
        .filter(Boolean).join("");

      body = (
        <svg viewBox={`0 0 ${W} ${totalH}`}
          style={{ width: "100%", display: "block", background: "#0b0f16", borderRadius: 8 }}>

          {/* ── PRICE panel label ── */}
          <text x={PADL} y={PADT - 6} fill="#e6edf5" fontSize={11.5} fontFamily="monospace" fontWeight={700}>
            PRICE (weekly candles)
          </text>

          {/* ── price grid ── */}
          {pTicks.map((v, i) => (
            <g key={"pg" + i}>
              <line x1={PADL} x2={W - PADR} y1={PY(v)} y2={PY(v)} stroke={GRID} strokeWidth={0.8} />
              <text x={PADL - 5} y={PY(v) + 4} fill={TEXT} fontSize={9.5} textAnchor="end" fontFamily="monospace">
                ₹{v >= 10000 ? Math.round(v/100)/10+"k" : Math.round(v)}
              </text>
            </g>
          ))}

          {/* ── candlesticks ── */}
          {candles.map((c, i) => (
            <g key={"c" + i}>
              {/* wick */}
              <line x1={c.cx} x2={c.cx} y1={c.wickTop} y2={c.wickBot}
                stroke={c.col} strokeWidth={1} opacity={0.7} />
              {/* body */}
              <rect x={c.cx - barW / 2} y={c.bodyTop} width={barW} height={c.bodyH}
                fill={c.bull ? "none" : c.col}
                stroke={c.col} strokeWidth={c.bull ? 1 : 0}
                opacity={0.9} />
            </g>
          ))}

          {/* ── RSI panel label ── */}
          <text x={PADL} y={rTop - 8} fill="#e6edf5" fontSize={11.5} fontFamily="monospace" fontWeight={700}>
            RSI (14)
          </text>

          {/* ── RSI grid ── */}
          {rTicks.map(v => (
            <g key={"rg" + v}>
              <line x1={PADL} x2={W - PADR} y1={RY(v)} y2={RY(v)}
                stroke={v === 30 || v === 70 ? "#2a3342" : GRID}
                strokeWidth={0.8} strokeDasharray={v === 50 ? "" : "3 4"} />
              <text x={PADL - 5} y={RY(v) + 4} fill={v === 30 ? "#f87171" : v === 70 ? "#fbbf24" : TEXT}
                fontSize={9.5} textAnchor="end" fontFamily="monospace">{v}</text>
            </g>
          ))}

          {/* ── RSI 30/70 fill zones ── */}
          <rect x={PADL} y={RY(70)} width={W - PADL - PADR} height={RY(30) - RY(70)}
            fill="rgba(251,191,36,0.03)" />

          {/* ── RSI line ── */}
          <path d={rsiPath} fill="none" stroke="#c084fc" strokeWidth={1.4} />

          {/* ── divergence events ── */}
          {data.events.map((e, i) => {
            const col = e.type === "bullish" ? GREEN : RED;
            const pi1 = e.p1.x, pi2 = e.p2.x;
            // price panel: bullish = lows, bearish = highs
            const py1 = e.type === "bullish" ? PY(data.lows[pi1])  : PY(data.highs[pi1]);
            const py2 = e.type === "bullish" ? PY(data.lows[pi2])  : PY(data.highs[pi2]);
            // rsi panel: actual RSI values at pivot bars
            const ry1 = RY(e.p1.rsi), ry2 = RY(e.p2.rsi);
            const cx = X(Math.min(e.confirmX, n - 1));
            const ci = Math.min(e.confirmX, n - 1);

            return (
              <g key={"ev" + i}>
                {/* price trendline on actual low/high */}
                <line x1={X(pi1)} y1={py1} x2={X(pi2)} y2={py2}
                  stroke={col} strokeWidth={2} strokeLinecap="round" />
                <circle cx={X(pi1)} cy={py1} r={4} fill={col} opacity={0.9} />
                <circle cx={X(pi2)} cy={py2} r={4} fill={col} opacity={0.9} />

                {/* price labels */}
                <text x={X(pi1)} y={e.type === "bullish" ? py1 + 14 : py1 - 7}
                  fill={col} fontSize={9} textAnchor="middle" fontFamily="monospace">
                  ₹{Math.round(e.p1.price)}
                </text>
                <text x={X(pi2)} y={e.type === "bullish" ? py2 + 14 : py2 - 7}
                  fill={col} fontSize={9} textAnchor="middle" fontFamily="monospace">
                  ₹{Math.round(e.p2.price)}
                </text>

                {/* rsi trendline */}
                <line x1={X(pi1)} y1={ry1} x2={X(pi2)} y2={ry2}
                  stroke={col} strokeWidth={2} strokeLinecap="round" />
                <circle cx={X(pi1)} cy={ry1} r={3.5} fill={col} opacity={0.9} />
                <circle cx={X(pi2)} cy={ry2} r={3.5} fill={col} opacity={0.9} />

                {/* rsi labels */}
                <text x={X(pi1)} y={e.type === "bullish" ? ry1 + 13 : ry1 - 6}
                  fill={col} fontSize={9} textAnchor="middle" fontFamily="monospace">
                  {e.p1.rsi.toFixed(1)}
                </text>
                <text x={X(pi2)} y={e.type === "bullish" ? ry2 + 13 : ry2 - 6}
                  fill={col} fontSize={9} textAnchor="middle" fontFamily="monospace">
                  {e.p2.rsi.toFixed(1)}
                </text>

                {/* vertical guide from pivot to confirm */}
                <line x1={X(pi2)} y1={py2} x2={cx} y2={e.type === "bullish" ? PY(pMin) + 10 : PADT + 4}
                  stroke={col} strokeWidth={0.6} strokeDasharray="3 5" opacity={0.35} />

                {/* confirm triangle on price chart */}
                <text x={cx}
                  y={e.type === "bullish"
                    ? PY(data.lows[ci]) + 18
                    : PY(data.highs[ci]) - 10}
                  fill={col} fontSize={14} textAnchor="middle" fontWeight={700}>
                  {e.type === "bullish" ? "▲" : "▼"}
                </text>
                <text x={cx}
                  y={e.type === "bullish"
                    ? PY(data.lows[ci]) + 28
                    : PY(data.highs[ci]) - 20}
                  fill={col} fontSize={8} textAnchor="middle" fontFamily="monospace" opacity={0.8}>
                  {e.confirmDate}
                </text>
              </g>
            );
          })}

          {/* ── date axis ── */}
          {dTicks.map(i => (
            <text key={"d" + i} x={X(i)} y={totalH - 8}
              fill={TEXT} fontSize={9} textAnchor="middle" fontFamily="monospace">
              {data.dates[i]}
            </text>
          ))}

          {/* ── panel separators ── */}
          <line x1={PADL} x2={W - PADR} y1={PADT + PH + GAP / 2} y2={PADT + PH + GAP / 2}
            stroke="#212836" strokeWidth={1} />
        </svg>
      );
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
      zIndex: 1000, display: "flex", alignItems: "center",
      justifyContent: "center", padding: 16
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#0f141c", border: "1px solid #2a3342",
        borderRadius: 12, width: "min(1020px, 97vw)",
        maxHeight: "94vh", overflowY: "auto", padding: 18
      }}>
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ color: "#e6edf5", fontWeight: 800, fontSize: 16 }}>
              📐 {symbol.replace(".NS", "")} — RSI Divergence
              {asOf && <span style={{ color: "#c084fc", fontSize: 12, marginLeft: 8 }}>as of {asOf} (playback)</span>}
            </div>
            {name && <div style={{ color: TEXT, fontSize: 12, marginTop: 2 }}>{name}</div>}
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center", fontFamily: "monospace", fontSize: 11.5 }}>
            <span style={{ color: GREEN }}>━● Bullish (▲ confirm)</span>
            <span style={{ color: RED }}>━● Bearish (▼ confirm)</span>
            <button onClick={onClose} style={{
              background: "#151b27", border: "1px solid #2a3342",
              color: "#e6edf5", borderRadius: 6, padding: "4px 14px",
              cursor: "pointer", fontSize: 13
            }}>✕ Close</button>
          </div>
        </div>

        {body}

        {data && data.events.length === 0 && (
          <div style={{ color: TEXT, fontFamily: "monospace", fontSize: 12, marginTop: 8 }}>
            Is window mein koi divergence event nahi mila.
          </div>
        )}
        <div style={{ color: "#576575", fontFamily: "monospace", fontSize: 10.5, marginTop: 10, lineHeight: 1.6 }}>
          ● dots = actual swing low/high par (bullish = price low pe, RSI low pe). Trendline dono panels pe opposite slope dikhati hai — yehi divergence hai.
          ▲/▼ = confirm bar (pivot ke 3 bars baad — no look-ahead). Weekly candles: green body = bullish, hollow = bearish.
        </div>
      </div>
    </div>
  );
}
