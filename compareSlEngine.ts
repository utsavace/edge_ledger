// ============================================================================
// compareSlEngine.ts — v2: ALL 6 REAL M1 STRATEGIES, exit-scheme comparison
// ----------------------------------------------------------------------------
// Dashboard ko BILKUL nahi chhoota. Har M1 strategy (jo scan.ts me actually chalti
// hai) ke apne REAL entry rules use hote hain — sirf EXIT rule badalta hai:
//   - "Native exit" = wahi jo dashboard abhi use karta hai (per-strategy alag)
//   - 6 aur schemes (8% flat, 5%/15%, 3x ATR-based, etc.)
// "M3 Best Overall Edge" ek fixed strategy NAHI hai — scan.ts me dynamically
// jo M1 strategy sabse zyada stocks pe pass kare wahi M3 ban jaati hai. Isliye
// hum SABHI 6 test karte hain, taaki pata chale ATR-exit kis-kis ke liye
// (agar kisi ke liye bhi) behtar hai — M3 chahe koi bhi ho.
// ============================================================================

import { fetchStockData, calculateRSI, type OHLCV } from "./scan.ts";

const COST_PCT = 0.2;
const NO_LOSS_PF_CAP = 10.0;

// ---- indicators (scan.ts se hu-ba-hu) ----
function calculateEMA(closes: number[], period: number): number[] {
  const ema: number[] = [];
  if (closes.length === 0) return [];
  const multiplier = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, closes.length); i++) { sum += closes[i]; ema.push(sum / (i + 1)); }
  for (let i = period; i < closes.length; i++) ema.push(closes[i] * multiplier + ema[i - 1] * (1 - multiplier));
  return ema;
}
function calculateMACD(closes: number[]) {
  const ema12 = calculateEMA(closes, 12), ema26 = calculateEMA(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] || 0) - (ema26[i] || 0));
  const signalLine = calculateEMA(macdLine, 9);
  const histogram = closes.map((_, i) => macdLine[i] - (signalLine[i] || 0));
  return { macdLine, signalLine, histogram };
}
function calculateBollingerBands(closes: number[], period = 20, multiplier = 2) {
  const upper: number[] = [], middle: number[] = [], lower: number[] = [], bandwidth: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { middle.push(closes[i]); upper.push(closes[i]); lower.push(closes[i]); bandwidth.push(0); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    const up = sma + multiplier * stdDev, dn = sma - multiplier * stdDev;
    middle.push(sma); upper.push(up); lower.push(dn);
    bandwidth.push(sma === 0 ? 0 : (up - dn) / sma);
  }
  return { upper, middle, lower, bandwidth };
}
function calculateStochasticRSI(rsi: number[], period = 14, kPeriod = 3, dPeriod = 3) {
  const stochRSI: number[] = [];
  for (let i = 0; i < rsi.length; i++) {
    if (i < period - 1) { stochRSI.push(50); continue; }
    const slice = rsi.slice(i - period + 1, i + 1);
    const mn = Math.min(...slice), mx = Math.max(...slice), den = mx - mn;
    stochRSI.push(den === 0 ? 50 : ((rsi[i] - mn) / den) * 100);
  }
  const k = calculateEMA(stochRSI, kPeriod);
  const d = calculateEMA(k, dPeriod);
  return { k, d };
}
function calculateADX(data: OHLCV[], period = 14): number[] {
  if (data.length <= period * 2) return Array(data.length).fill(25);
  const adx = Array(data.length).fill(25);
  const tr = [0], plusDM = [0], minusDM = [0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i], p = data[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high, dn = p.low - c.low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  let trS = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let pS = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let mS = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dxList = Array(period).fill(0);
  for (let i = period; i < data.length; i++) {
    if (i > period) { trS = trS - trS / period + tr[i]; pS = pS - pS / period + plusDM[i]; mS = mS - mS / period + minusDM[i]; }
    const pDI = trS === 0 ? 0 : (pS / trS) * 100, mDI = trS === 0 ? 0 : (mS / trS) * 100;
    const sum = pDI + mDI, diff = Math.abs(pDI - mDI);
    dxList.push(sum === 0 ? 0 : (diff / sum) * 100);
  }
  let adxSum = dxList.slice(period, period * 2).reduce((a, b) => a + b, 0);
  adx[period * 2 - 1] = adxSum / period;
  for (let i = period * 2; i < data.length; i++) { adxSum = adxSum - adxSum / period + (dxList[i] || 0); adx[i] = adxSum / period; }
  return adx;
}
function calculateATR(data: OHLCV[], period = 14): number[] {
  const atr = Array(data.length).fill(0);
  if (data.length < period + 1) return atr;
  const tr: number[] = [0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i], p = data[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let sum = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  atr[period] = sum / period;
  for (let i = period + 1; i < data.length; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

// ---- exit schemes (NATIVE ke alawa 6 aur) ----
type Scheme = { key: string; label: string; levels: (entry: number, atr: number, avgRet: number) => { stop: number; target: number } | null };
export const SCHEMES: Scheme[] = [
  { key: "IND",      label: "Native exit (dashboard's own rule for this strategy)", levels: () => null },
  { key: "SL8_AVG",  label: "8% SL + avg-return target (callout)",  levels: (e, _a, av) => ({ stop: e * 0.92, target: e * (1 + Math.max(av, 1) / 100) }) },
  { key: "SL8_2R",   label: "8% SL + fixed 1:2 R:R",                levels: (e) => ({ stop: e * 0.92, target: e * (1 + 0.08 * 2) }) },
  { key: "SL5_15",   label: "5% SL + 15% target (m2 style)",        levels: (e) => ({ stop: e * 0.95, target: e * 1.15 }) },
  { key: "ATR2_3",   label: "2x ATR SL + 3x ATR target (~1:1.5)",   levels: (e, a) => ({ stop: e - 2 * a, target: e + 3 * a }) },
  { key: "ATR25_2R", label: "2.5x ATR SL + fixed 1:2 R:R",          levels: (e, a) => ({ stop: e - 2.5 * a, target: e + 2.5 * a * 2 }) },
  { key: "ATR3_45",  label: "3x ATR SL + 4.5x ATR target (~1:1.5)", levels: (e, a) => ({ stop: e - 3 * a, target: e + 4.5 * a }) },
];

// ---- ALL 6 REAL M1 STRATEGIES (scan.ts se hu-ba-hu entry AND native-exit logic) ----
type StratId = "m1_rsi_macd" | "m1_ema_pullback" | "m1_bb_squeeze" | "m1_rsi_mean_rev" | "m1_dual_ema" | "m1_stoch_rsi";
const STRAT_LABELS: Record<StratId, string> = {
  m1_rsi_macd: "RSI(14) + MACD Cross",
  m1_ema_pullback: "EMA 50 Pullback + Volume",
  m1_bb_squeeze: "Bollinger Bands Squeeze Breakout",
  m1_rsi_mean_rev: "RSI Extreme Mean Reversion",
  m1_dual_ema: "Dual EMA Trend Follower",
  m1_stoch_rsi: "Stochastic RSI Trend Filter",
};
const ALL_STRATS: StratId[] = ["m1_rsi_macd", "m1_ema_pullback", "m1_bb_squeeze", "m1_rsi_mean_rev", "m1_dual_ema", "m1_stoch_rsi"];

function entryTrigger(id: StratId, i: number, ind: any): boolean {
  const { closes, opens, ema9, ema21, ema50, macd, bb, stochRsi, adx, rsi, avgVol20, volumes } = ind;
  const price = closes[i];
  if (id === "m1_rsi_macd")
    return rsi[i] < 40 && (macd.histogram[i] || 0) > 0 && (macd.histogram[i - 1] || 0) <= 0;
  if (id === "m1_ema_pullback")
    return ind.lows[i] <= (ema50[i] || 0) && ind.highs[i] >= (ema50[i] || 0) && volumes[i] > 1.5 * (avgVol20[i] || 1);
  if (id === "m1_bb_squeeze")
    return (bb.bandwidth[i - 1] || 0) < 0.05 && price > (bb.upper[i] || 0);
  if (id === "m1_rsi_mean_rev") {
    const isBullishEngulfing = i > 0 && closes[i - 1] < opens[i - 1] && opens[i] <= closes[i - 1] && closes[i] >= opens[i - 1] && closes[i] > opens[i];
    return rsi[i] < 25 && isBullishEngulfing;
  }
  if (id === "m1_dual_ema")
    return (ema9[i] || 0) > (ema21[i] || 0) && (ema9[i - 1] || 0) <= (ema21[i - 1] || 0) && price > (ema50[i] || 0);
  // m1_stoch_rsi
  return (stochRsi.k[i] || 0) > (stochRsi.d[i] || 0) && (stochRsi.k[i - 1] || 0) <= (stochRsi.d[i - 1] || 0) && (stochRsi.k[i] || 0) < 20 && (adx[i] || 0) > 25;
}
function nativeExit(id: StratId, i: number, ind: any): boolean {
  const { closes, ema9, ema21, macd, bb, stochRsi, rsi } = ind;
  const price = closes[i];
  if (id === "m1_rsi_macd") return rsi[i] > 70 || (macd.histogram[i] || 0) < 0;
  if (id === "m1_ema_pullback") return price < (ema21[i] || 0);
  if (id === "m1_bb_squeeze") return price < (bb.middle[i] || 0);
  if (id === "m1_rsi_mean_rev") return rsi[i] > 50;
  if (id === "m1_dual_ema") return (ema9[i] || 0) < (ema21[i] || 0);
  return (stochRsi.k[i] || 0) < (stochRsi.d[i] || 0) && (stochRsi.k[i] || 0) > 80; // m1_stoch_rsi
}

interface TradeOut { ret: number; rr: number | null }
function backtest(id: StratId, data: OHLCV[], ind: any, scheme: Scheme): TradeOut[] {
  const opens = data.map(d => d.open), highs = data.map(d => d.high), lows = data.map(d => d.low), closes = data.map(d => d.close);
  const atr = ind.atr as number[];
  const out: TradeOut[] = [];
  let inPos = false, entry = 0, slLvl = 0, tgtLvl = 0, useLevels = false, plannedRR: number | null = null, pending = false;

  for (let i = 50; i < data.length; i++) {
    if (!inPos) {
      if (pending) {
        inPos = true; entry = opens[i]; pending = false;
        const lv = scheme.levels(entry, atr[i] || (entry * 0.03), ind.avgRetForScheme ?? 5);
        if (lv) { useLevels = true; slLvl = lv.stop; tgtLvl = lv.target; plannedRR = (tgtLvl - entry) > 0 && (entry - slLvl) > 0 ? (tgtLvl - entry) / (entry - slLvl) : null; }
        else { useLevels = false; plannedRR = null; }
        continue;
      }
      if (entryTrigger(id, i, ind) && i < data.length - 1) pending = true;
    } else {
      let exit = false, exitPrice = closes[i];
      if (useLevels) {
        if (opens[i] <= slLvl) { exit = true; exitPrice = opens[i]; }
        else if (lows[i] <= slLvl) { exit = true; exitPrice = slLvl; }
        else if (opens[i] >= tgtLvl) { exit = true; exitPrice = opens[i]; }
        else if (highs[i] >= tgtLvl) { exit = true; exitPrice = tgtLvl; }
      } else if (nativeExit(id, i, ind)) { exit = true; exitPrice = closes[i]; }
      if (exit || i === data.length - 1) {
        if (!exit) exitPrice = closes[i];
        inPos = false;
        out.push({ ret: ((exitPrice - entry) / entry) * 100 - COST_PCT, rr: plannedRR });
      }
    }
  }
  return out;
}

export interface SchemeAgg {
  key: string; label: string; trades: number; winRatePct: number; profitFactor: number;
  avgReturnPct: number; expectancyPct: number; avgWinPct: number; avgLossPct: number;
  maxDrawdownPct: number; avgPlannedRR: number | null;
}
function agg(trades: TradeOut[]): Omit<SchemeAgg, "key" | "label"> | null {
  const n = trades.length;
  if (n === 0) return null;
  const rets = trades.map(t => t.ret);
  const wins = rets.filter(r => r > 0), losses = rets.filter(r => r <= 0);
  const gp = wins.reduce((a, b) => a + b, 0), gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  const pf = gl === 0 ? (gp > 0 ? NO_LOSS_PF_CAP : 1) : Math.min(gp / gl, NO_LOSS_PF_CAP);
  const avg = rets.reduce((a, b) => a + b, 0) / n;
  const rrs = trades.map(t => t.rr).filter((x): x is number => x != null);
  let bal = 100, peak = 100, maxDD = 0;
  for (const r of rets) { bal *= (1 + r / 100); if (bal > peak) peak = bal; const dd = ((peak - bal) / peak) * 100; if (dd > maxDD) maxDD = dd; }
  return {
    trades: n,
    winRatePct: +(wins.length / n * 100).toFixed(1),
    profitFactor: +pf.toFixed(2),
    avgReturnPct: +avg.toFixed(2),
    expectancyPct: +avg.toFixed(2),
    avgWinPct: +(wins.length ? gp / wins.length : 0).toFixed(2),
    avgLossPct: +(losses.length ? -gl / losses.length : 0).toFixed(2),
    maxDrawdownPct: +maxDD.toFixed(1),
    avgPlannedRR: rrs.length ? +(rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(2) : null,
  };
}

export interface CompareResult {
  ok: true;
  universeRequested: number;
  universeUsed: number;
  skipped: string[];
  elapsedSec: number;
  strategies: {
    id: StratId;
    label: string;
    schemes: SchemeAgg[];
    best: { key: string; label: string; reason: string } | null;
  }[];
  note: string;
}

export async function runCompareSl(
  universe: { symbol: string; name: string }[],
  onProgress?: (done: number, total: number, sym: string) => void
): Promise<CompareResult> {
  const t0 = Date.now();
  const bucket: Record<string, Record<string, TradeOut[]>> = {};
  for (const s of ALL_STRATS) { bucket[s] = {}; for (const sc of SCHEMES) bucket[s][sc.key] = []; }

  let done = 0, used = 0;
  const skipped: string[] = [];

  const BATCH = 12;
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    await Promise.all(batch.map(async (t) => {
      let data: OHLCV[] | null = null;
      try {
        const fs = await import("fs");
        const path = await import("path");
        const cachedPath = path.join(process.cwd(), "data", "ohlcv", `${t.symbol}.json`);
        if (fs.existsSync(cachedPath)) {
          const raw = JSON.parse(fs.readFileSync(cachedPath, "utf8"));
          data = raw.d.map((d: string, idx: number) => ({ date: d, open: raw.o[idx], high: raw.h[idx], low: raw.l[idx], close: raw.c[idx], volume: raw.v ? raw.v[idx] : 0 }));
        }
      } catch { /* fall through to live fetch */ }
      if (!data) data = await fetchStockData(t.symbol);
      done++;
      if (onProgress) onProgress(done, universe.length, t.symbol);
      if (!data || data.length < 120) { skipped.push(t.symbol); return; }
      used++;
      const closes = data.map(d => d.close), opens = data.map(d => d.open), highs = data.map(d => d.high), lows = data.map(d => d.low), volumes = data.map(d => d.volume);
      const rsi = calculateRSI(closes, 14);
      const avgVol20: number[] = [];
      let volSum = 0;
      for (let j = 0; j < data.length; j++) { volSum += volumes[j]; if (j >= 20) volSum -= volumes[j - 20]; avgVol20.push(volSum / Math.min(j + 1, 20)); }
      const ind = {
        closes, opens, highs, lows, volumes, rsi, avgVol20,
        ema9: calculateEMA(closes, 9), ema21: calculateEMA(closes, 21), ema50: calculateEMA(closes, 50),
        macd: calculateMACD(closes), bb: calculateBollingerBands(closes, 20, 2),
        stochRsi: calculateStochasticRSI(rsi, 14, 3, 3), adx: calculateADX(data, 14), atr: calculateATR(data, 14),
      };
      for (const id of ALL_STRATS) {
        const nativeTrades = backtest(id, data, { ...ind, avgRetForScheme: 5 }, SCHEMES[0]);
        const nativeAvg = nativeTrades.length ? nativeTrades.reduce((a, b) => a + b.ret, 0) / nativeTrades.length : 5;
        const avgRet = Math.max(nativeAvg, 1);
        for (const sc of SCHEMES) {
          const tr = sc.key === "IND" ? nativeTrades : backtest(id, data, { ...ind, avgRetForScheme: avgRet }, sc);
          bucket[id][sc.key].push(...tr);
        }
      }
    }));
  }

  const strategiesOut = ALL_STRATS.map((id) => {
    const schemes: SchemeAgg[] = SCHEMES.map(sc => {
      const a = agg(bucket[id][sc.key]);
      return a ? { key: sc.key, label: sc.label, ...a } : { key: sc.key, label: sc.label, trades: 0, winRatePct: 0, profitFactor: 0, avgReturnPct: 0, expectancyPct: 0, avgWinPct: 0, avgLossPct: 0, maxDrawdownPct: 0, avgPlannedRR: null };
    });
    const withTrades = schemes.filter(s => s.trades > 0);
    let best: { key: string; label: string; reason: string } | null = null;
    if (withTrades.length) {
      const top = [...withTrades].sort((a, b) => b.expectancyPct - a.expectancyPct)[0];
      const nat = schemes.find(s => s.key === "IND");
      const beatsNative = nat && nat.trades > 0 ? (top.expectancyPct > nat.expectancyPct && top.profitFactor > nat.profitFactor) : true;
      best = {
        key: top.key, label: top.label,
        reason: beatsNative
          ? `Highest expectancy (${top.expectancyPct}%/trade) AND better PF (${top.profitFactor}) than native exit — worth switching for THIS strategy.`
          : `Highest expectancy (${top.expectancyPct}%/trade) but does NOT clearly beat native exit on PF — keep native exit for this strategy.`,
      };
    }
    return { id, label: STRAT_LABELS[id], schemes, best };
  });

  return {
    ok: true,
    universeRequested: universe.length,
    universeUsed: used,
    skipped,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
    strategies: strategiesOut,
    note: "Har M1 strategy ka apna REAL entry + native exit test hua hai (jo dashboard abhi use karta hai), 6 alternate exit schemes ke against. 'M3 Best Overall Edge' fixed strategy nahi hai — jo bhi M1 strategy sabse zyada stocks pe pass kare wahi M3 ban jaati hai, isliye sabhi 6 yahan test kiye gaye. Net of 0.2% cost/trade.",
  };
}