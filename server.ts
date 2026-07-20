import express from "express";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import dotenv from "dotenv";
import { runScan, NO_LOSS_PF_CAP, fetchStockData, evaluateTradeOutcome, STRATEGIES_POOL, type JournalTrade, calculateRSI, detectDivergences, toWeekly, loadNifty500Tickers, M4_MIN_TRADES, M4_MIN_WIN_RATE, M4_MIN_PF, backtestConnorsRSI, M6_MIN_TRADES, M6_MIN_WIN_RATE, M6_MIN_PF, M6_SECTORS, backtestTurtleSoup, TS_MIN_TRADES, TS_MIN_WIN_RATE, TS_MIN_PF, TS_LOOKBACK, TS_MIN_GAP, TS_TRAIL_ATR, ADX_LIVE_FILTER } from "./scan.ts";
import { runCompareSl } from "./compareSlEngine.ts";

// Load env for GEMINI_API_KEY (README uses .env.local; AI Studio injects at runtime)
dotenv.config({ path: ".env.local" });
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const CACHE = path.join(process.cwd(), "public", "cache");

// ---------- Personal trade journal storage (survives scans — NOT inside /cache) ----------
const DATA_DIR = path.join(process.cwd(), "data");
const TRADES_FILE = path.join(DATA_DIR, "mytrades.json");

function readTrades(): JournalTrade[] {
  try {
    if (!fs.existsSync(TRADES_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTrades(trades: JournalTrade[]) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

app.use(express.json());

interface ScanStatus {
  isScanning: boolean;
  progress: number;
  scanned: number;
  currentSymbol: string;
  passedCount: number;
  logs: string[];
}

let scanStatus: ScanStatus = {
  isScanning: false,
  progress: 0,
  scanned: 0,
  currentSymbol: "",
  passedCount: 0,
  logs: []
};

// ============================================================================
// AUTO-REFRESH SCHEDULER (production only)
// ----------------------------------------------------------------------------
// Without this, the dashboard shows whatever "Data generated at" timestamp the
// LAST scan produced — forever, until someone manually clicks "Fetch Fresh Data".
// This runs runScan() automatically every 2 hours during NSE market hours (IST),
// directly on the live Render instance (no git push needed — it just refreshes
// this running server's own public/cache files, same as the manual button does).
// Disabled outside production so it never fires inside the AI Studio dev sandbox.
// ============================================================================
const AUTO_SCAN_INTERVAL_MS = 2 * 60 * 60 * 1000; // every 2 hours

function nowIST(): Date {
  // Shift current UTC time by +5:30 so getUTC* reads back as IST wall-clock time,
  // regardless of what timezone the server OS itself is running in.
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function isAutoScanWindowIST(d: Date): boolean {
  const day = d.getUTCDay(); // 0 = Sun, 6 = Sat (NSE closed)
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const MARKET_OPEN = 9 * 60 + 15;   // 9:15 AM IST
  const REFRESH_CUTOFF = 16 * 60;    // 4:00 PM IST (one extra pass after the 3:30 close to pick up final EOD candles)
  return mins >= MARKET_OPEN && mins <= REFRESH_CUTOFF;
}

function scheduleAutoScan() {
  if (process.env.NODE_ENV !== "production") return; // AI Studio dev sandbox: manual button only
  setInterval(() => {
    if (scanStatus.isScanning) return; // never overlap with an in-progress scan
    if (!isAutoScanWindowIST(nowIST())) return;

    scanStatus = {
      isScanning: true,
      progress: 0,
      scanned: 0,
      currentSymbol: "Scheduled auto-refresh starting...",
      passedCount: 0,
      logs: [`⏱ Auto-refresh triggered at ${new Date().toISOString()}`]
    };
    runScan((progress, scanned, currentSymbol, passedCount, logLine) => {
      scanStatus.progress = progress;
      scanStatus.scanned = scanned;
      scanStatus.currentSymbol = currentSymbol;
      scanStatus.passedCount = passedCount;
      scanStatus.logs.push(logLine);
      if (scanStatus.logs.length > 80) scanStatus.logs.shift();
    }).then(() => {
      scanStatus.isScanning = false;
      scanStatus.progress = 100;
      scanStatus.logs.push("🎉 Scheduled auto-refresh complete — cache updated.");
    }).catch((err) => {
      scanStatus.isScanning = false;
      scanStatus.logs.push(`❌ Auto-refresh failed: ${err?.message || err}`);
    });
  }, AUTO_SCAN_INTERVAL_MS);
}

function readCache(name: string) {
  const p = path.join(CACHE, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Verifies cached rows actually obey the gate recorded in meta. Stops a stale cache
// (e.g. rows built under an old MIN_TRADES/PF rule) from being served and contradicting
// its own meta. If invalid, callers are told needsScan so the UI prompts a rebuild.
function validateCache(): { valid: boolean; reason?: string } {
  const meta = readCache("meta.json");
  if (!meta || meta.needsScan) return { valid: false, reason: "no meta" };
  const g = meta.gate;
  if (!g) return { valid: false, reason: "no gate in meta" };

  const minWR = (g.minWinRate ?? 0) * 100;
  // Base gate = what module 2 rows satisfy; strict gate = modules 1 & 3.
  // Validating everything against ONE gate previously self-invalidated fresh caches
  // whenever an M2 row sat between the base and strict thresholds.
  const baseT = g.minOosTrades ?? 0;
  const basePF = g.minProfitFactor ?? 0;
  const strictT = g.strict?.minOosTrades ?? baseT;
  const strictPF = g.strict?.minProfitFactor ?? basePF;

  for (const n of ["1", "6", "7"]) {
    const isStrictModule = n !== "6" && n !== "7";
    const minT = n === "6" ? M6_MIN_TRADES : n === "7" ? TS_MIN_TRADES : isStrictModule ? strictT : baseT;
    const minPF = n === "6" ? M6_MIN_PF : n === "7" ? TS_MIN_PF : isStrictModule ? strictPF : basePF;
    const minWRCheck = n === "6" ? M6_MIN_WIN_RATE : n === "7" ? TS_MIN_WIN_RATE : minWR;

    const rows = readCache(`module${n}.json`);
    if (rows === null) return { valid: false, reason: `module${n} missing` };
    for (const r of rows) {
      if (r.liveSignal) continue; // Skip gate check for active live setups
      if (r.numTrades < minT)
        return { valid: false, reason: `m${n} ${r.symbol}: ${r.numTrades} trades < gate ${minT}` };
      if (r.winRatePct < minWRCheck - 0.01)
        return { valid: false, reason: `m${n} ${r.symbol}: WR ${r.winRatePct} < gate ${minWRCheck}` };
      if (r.profitFactor < minPF - 0.01 || r.profitFactor > NO_LOSS_PF_CAP + 0.01)
        return { valid: false, reason: `m${n} ${r.symbol}: PF ${r.profitFactor} outside [${minPF}, ${NO_LOSS_PF_CAP}]` };
    }
  }
  return { valid: true };
}

app.get("/api/meta", (_req, res) => {
  const meta = readCache("meta.json");
  if (!meta) return res.json({ needsScan: true });
  const check = validateCache();
  if (!check.valid) {
    console.warn(`⚠️ Stale cache ignored → ${check.reason}`);
    return res.json({ needsScan: true, stale: true, reason: check.reason });
  }
  res.json(meta);
});

app.get("/api/module/:n", (req, res) => {
  const n = req.params.n;
  if (!["1", "6", "7"].includes(n)) return res.status(400).json({ error: "module must be 1, 6 or 7" });
  if (!validateCache().valid) return res.json({ needsScan: true, stale: true, rows: [] });
  const data = readCache(`module${n}.json`);
  if (data === null) return res.json({ needsScan: true, rows: [] });
  res.json({ rows: data });
});

app.post("/api/scan/start", async (_req, res) => {
  if (scanStatus.isScanning) {
    return res.json({ status: "already_running" });
  }

  scanStatus = {
    isScanning: true,
    progress: 0,
    scanned: 0,
    currentSymbol: "Starting...",
    passedCount: 0,
    logs: ["Initializing server-side scanner session..."]
  };

  res.json({ status: "started" });

  // Start background scan async so it doesn't block the request
  runScan((progress, scanned, currentSymbol, passedCount, logLine) => {
    scanStatus.progress = progress;
    scanStatus.scanned = scanned;
    scanStatus.currentSymbol = currentSymbol;
    scanStatus.passedCount = passedCount;
    scanStatus.logs.push(logLine);
    if (scanStatus.logs.length > 80) {
      scanStatus.logs.shift(); // Keep logs memory bound
    }
  }).then(() => {
    scanStatus.isScanning = false;
    scanStatus.progress = 100;
    scanStatus.logs.push("🎉 Scan complete. Refreshing edge dashboards.");
  }).catch((err) => {
    scanStatus.isScanning = false;
    scanStatus.logs.push(`❌ Error encountered during scanning: ${err.message || err}`);
  });
});

app.get("/api/scan/status", (_req, res) => {
  res.json(scanStatus);
});

// ==================== PERSONAL TRADE JOURNAL API ====================

// List all journaled trades (open first, newest first)
app.get("/api/trades", (_req, res) => {
  const trades = readTrades();
  trades.sort((a, b) => (a.status === "OPEN" ? 0 : 1) - (b.status === "OPEN" ? 0 : 1) || b.takenAt.localeCompare(a.takenAt));
  res.json({ trades });
});

// Tick "I'm taking this trade" — freezes entry/SL/target at this moment
app.post("/api/trades/take", (req, res) => {
  const b = req.body || {};
  const entryPrice = Number(b.entryPrice);
  const stopPrice = Number(b.stopPrice);
  const targetPrice = Number(b.targetPrice);
  if (!b.symbol || !isFinite(entryPrice) || entryPrice <= 0)
    return res.status(400).json({ ok: false, error: "symbol aur valid entryPrice zaroori hai" });
  if (!isFinite(stopPrice) || !isFinite(targetPrice) || stopPrice >= entryPrice || targetPrice <= entryPrice)
    return res.status(400).json({ ok: false, error: "Stop entry se NEECHE aur target entry se UPAR hona chahiye" });

  const trade: JournalTrade = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    symbol: String(b.symbol),
    name: b.name ? String(b.name) : undefined,
    strategyId: b.strategyId ? String(b.strategyId) : undefined,
    strategyLabel: b.strategyLabel ? String(b.strategyLabel) : undefined,
    module: b.module ? String(b.module) : undefined,
    takenAt: new Date().toISOString(),
    entryDate: new Date().toISOString().slice(0, 10),
    entryPrice,
    stopPrice,
    targetPrice,
    status: "OPEN",
    depthPct: isFinite(Number(b.depthPct)) ? Number(b.depthPct) : undefined,
    durationM: isFinite(Number(b.durationM)) ? Number(b.durationM) : undefined,
    note: b.note ? String(b.note).slice(0, 500) : undefined
  };
  const trades = readTrades();
  // Duplicate guard: same symbol + strategy already OPEN → double tick roka
  const dup = trades.find((t) => t.status === "OPEN" && t.symbol === trade.symbol && (t.strategyId || "") === (trade.strategyId || ""));
  if (dup) return res.status(409).json({ ok: false, error: `${trade.symbol} ka is strategy pe ek OPEN trade pehle se journal mein hai (${dup.entryDate})` });
  trades.push(trade);
  writeTrades(trades);
  res.json({ ok: true, trade });
});

// Auto-check every OPEN trade against fresh Yahoo candles: SL hit? Target hit? Still running?
app.post("/api/trades/check", async (_req, res) => {
  const trades = readTrades();
  const open = trades.filter((t) => t.status === "OPEN");
  if (open.length === 0) return res.json({ ok: true, updated: 0, trades });

  // One fetch per unique symbol (not per trade)
  const symbols = [...new Set(open.map((t) => t.symbol))];
  const candleMap: Record<string, Awaited<ReturnType<typeof fetchStockData>>> = {};
  for (const sym of symbols) {
    candleMap[sym] = await fetchStockData(sym);
  }

  let updated = 0;
  const failed: string[] = [];
  for (const t of open) {
    const ohlcv = candleMap[t.symbol];
    if (!ohlcv) { failed.push(t.symbol); continue; } // network fail → leave as-is, NEVER fake-close on synthetic data
    const out = evaluateTradeOutcome(t.entryDate, t.entryPrice, t.stopPrice, t.targetPrice, ohlcv);
    if (out.status === "OPEN") {
      t.currentPrice = out.currentPrice;
      t.unrealizedPct = out.currentPrice ? parseFloat((((out.currentPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2)) : undefined;
    } else {
      t.status = out.status;
      t.exitPrice = parseFloat((out.exitPrice as number).toFixed(2));
      t.exitDate = out.exitDate;
      t.returnPct = parseFloat((((t.exitPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2));
      t.currentPrice = undefined;
      t.unrealizedPct = undefined;
      updated++;
    }
  }
  writeTrades(trades);
  res.json({ ok: true, updated, failedSymbols: failed, trades });
});

// Manually close a trade (user exited on their own) at a given price
app.post("/api/trades/close", (req, res) => {
  const { id, exitPrice } = req.body || {};
  const px = Number(exitPrice);
  if (!id || !isFinite(px) || px <= 0) return res.status(400).json({ ok: false, error: "id aur valid exitPrice chahiye" });
  const trades = readTrades();
  const t = trades.find((x) => x.id === id);
  if (!t) return res.status(404).json({ ok: false, error: "trade nahi mila" });
  if (t.status !== "OPEN") return res.status(400).json({ ok: false, error: "trade pehle se closed hai" });
  t.status = "CLOSED_MANUAL";
  t.exitPrice = parseFloat(px.toFixed(2));
  t.exitDate = new Date().toISOString().slice(0, 10);
  t.returnPct = parseFloat((((px - t.entryPrice) / t.entryPrice) * 100).toFixed(2));
  t.currentPrice = undefined;
  t.unrealizedPct = undefined;
  writeTrades(trades);
  res.json({ ok: true, trade: t });
});

// Delete a journal entry
app.post("/api/trades/delete", (req, res) => {
  const { id } = req.body || {};
  const trades = readTrades();
  const next = trades.filter((t) => t.id !== id);
  if (next.length === trades.length) return res.status(404).json({ ok: false, error: "trade nahi mila" });
  writeTrades(next);
  res.json({ ok: true });
});

// Exit signal checker — open trades ke liye indicator-based exit signal check karo
// Uses playback data (pre-computed signals) to check if exit condition triggered today
app.get("/api/trades/exit-signals", async (_req, res) => {
  try {
    const trades = readTrades().filter((t: any) => t.status === "OPEN");
    const results: Record<string, { signal: boolean; reason: string; crsi?: number; stochK?: number; rsi?: number }> = {};

    const PLAYBACK_DIR = path.join(process.cwd(), "data", "playback");

    for (const t of trades) {
      const sid = t.strategyId || "";
      const sym = t.symbol;
      const pbFile = path.join(PLAYBACK_DIR, `${sym}.json`);

      if (!fs.existsSync(pbFile)) {
        results[t.id] = { signal: false, reason: "Data loading..." };
        continue;
      }

      try {
        const pb = JSON.parse(fs.readFileSync(pbFile, "utf-8"));
        const closes: number[] = pb.c || [];
        const dates: string[] = pb.d || [];
        const n = closes.length;
        if (n < 20) { results[t.id] = { signal: false, reason: "Insufficient data" }; continue; }

        // RSI Mean Reversion: exit when RSI > 50
        if (sid === "m1_rsi_mean_rev") {
          const rsi = calculateRSI(closes, 14);
          const latestRsi = Math.round(rsi[n - 1] * 10) / 10;
          results[t.id] = {
            signal: latestRsi > 50,
            reason: latestRsi > 50
              ? `⚠️ EXIT SIGNAL — RSI ${latestRsi} crossed above 50`
              : `✅ Holding — RSI ${latestRsi} (exit when > 50)`,
            rsi: latestRsi
          };
        }
        // StochRSI: exit when K crosses D above 80
        else if (sid === "m1_stoch_rsi") {
          const strats = pb.strategies?.["m1_stoch_rsi"];
          const sigs = strats?.signals || [];
          // Check latest signal from stored data — if most recent is within 3 bars and price near signal
          const latestRsi = calculateRSI(closes, 14);
          // Simple check: compute StochRSI on latest closes
          const rsi14 = latestRsi;
          const sp = 14; const kp = 3; const dp = 3;
          const k = new Array(n).fill(50);
          for (let i = sp - 1; i < n; i++) {
            const sl = rsi14.slice(i - sp + 1, i + 1);
            const lo = Math.min(...sl); const hi = Math.max(...sl);
            k[i] = hi > lo ? 100 * (rsi14[i] - lo) / (hi - lo) : 50;
          }
          const sk = new Array(n).fill(0);
          for (let i = kp - 1; i < n; i++) sk[i] = k.slice(i - kp + 1, i + 1).reduce((a: number, b: number) => a + b, 0) / kp;
          const d = new Array(n).fill(0);
          for (let i = dp - 1; i < n; i++) d[i] = sk.slice(i - dp + 1, i + 1).reduce((a: number, b: number) => a + b, 0) / dp;
          const kNow = Math.round(sk[n - 1] * 10) / 10;
          const dNow = Math.round(d[n - 1] * 10) / 10;
          const kPrev = sk[n - 2]; const dPrev = d[n - 2];
          const crossed = kNow > dNow && kPrev <= dPrev && kNow > 80;
          const above80 = kNow > 80;
          results[t.id] = {
            signal: crossed || above80,
            reason: crossed
              ? `⚠️ EXIT SIGNAL — StochRSI K (${kNow}) crossed D (${dNow}) above 80`
              : above80
              ? `⚠️ EXIT SIGNAL — StochRSI K ${kNow} above 80 (watch for D cross)`
              : `✅ Holding — StochRSI K ${kNow} / D ${dNow} (exit when K crosses D above 80)`,
            stochK: kNow
          };
        }
        // ConnorsRSI: exit when CRSI > 90
        else if (sid === "m6_connors_rsi") {
          const crsiResult = backtestConnorsRSI(
            dates.map((date, i) => ({ date, open: closes[i], high: closes[i], low: closes[i], close: closes[i], volume: 0 }))
          );
          // Recompute CRSI directly on latest bar
          const rsi3 = calculateRSI(closes, 3);
          const streak = new Array(n).fill(0);
          for (let i = 1; i < n; i++) {
            if (closes[i] > closes[i - 1]) streak[i] = Math.max(streak[i - 1], 0) + 1;
            else if (closes[i] < closes[i - 1]) streak[i] = Math.min(streak[i - 1], 0) - 1;
          }
          const minStr = Math.min(...streak);
          const strPos = streak.map((s: number) => s - minStr + 1);
          const rsiStr = calculateRSI(strPos, 2);
          const ret = new Array(n).fill(0);
          for (let i = 1; i < n; i++) ret[i] = closes[i - 1] > 0 ? (closes[i] - closes[i - 1]) / closes[i - 1] * 100 : 0;
          const pr = new Array(n).fill(50);
          for (let i = 100; i < n; i++) pr[i] = ret.slice(i - 100, i).filter((r: number) => r < ret[i]).length;
          const crsi = (rsi3[n - 1] + rsiStr[n - 1] + pr[n - 1]) / 3;
          const crsiRounded = Math.round(crsi * 10) / 10;
          results[t.id] = {
            signal: crsiRounded > 90,
            reason: crsiRounded > 90
              ? `⚠️ EXIT SIGNAL — ConnorsRSI ${crsiRounded} crossed above 90`
              : `✅ Holding — ConnorsRSI ${crsiRounded} (exit when > 90)`,
            crsi: crsiRounded
          };
        }
        else {
          results[t.id] = { signal: false, reason: `✅ Holding (${sid || "manual strategy"})` };
        }
      } catch {
        results[t.id] = { signal: false, reason: "Checking..." };
      }
    }
    res.json({ ok: true, signals: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Gemini AI review — ek trade ka (id bhejo) ya pura journal ka (id mat bhejo)
app.post("/api/trades/review", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return res.json({ ok: false, error: "GEMINI_API_KEY set nahi hai (.env.local mein daalo) — stats-based insights phir bhi kaam karenge." });
  }
  const { id, journal } = req.body || {};
  const isPb = journal === "playback";
  const trades = isPb ? readPbTrades() : readTrades();
  const closed = trades.filter((t) => t.status !== "OPEN");
  if (closed.length === 0) return res.json({ ok: false, error: "Abhi koi closed trade nahi hai review ke liye." });

  const describe = (t: JournalTrade) =>
    `${t.symbol} [${t.strategyLabel || t.module || "?"}] entry ₹${t.entryPrice} (${t.entryDate}), SL ₹${t.stopPrice}, target ₹${t.targetPrice}, result: ${t.status} @ ₹${t.exitPrice} (${t.exitDate}), return ${t.returnPct}%` +
    (t.depthPct ? `, cup depth ${t.depthPct}% / base ${t.durationM}m` : "") +
    (t.note ? `, note: "${t.note}"` : "");

  let prompt: string;
  let target: JournalTrade | undefined;
  if (id) {
    target = closed.find((t) => t.id === id);
    if (!target) return res.status(404).json({ ok: false, error: "closed trade nahi mila" });
    prompt = `You are a friendly swing-trading coach. Review this single closed trade and answer in Hinglish (Hindi written in Latin script). Be specific: kya sahi hua, kya galat, is trade se ek concrete lesson for next time. Max 120 words, no headings, no bullet spam.\n\nTrade: ${describe(target)}\n\nContext (user's other closed trades for pattern reference):\n${closed.filter((t) => t.id !== id).slice(-10).map(describe).join("\n") || "(koi aur trade nahi)"}`;
  } else {
    prompt = `You are a friendly swing-trading coach. Review this user's closed trades as a whole and answer in Hinglish (Hindi in Latin script). Identify 2-3 concrete patterns (e.g., kaunsi strategy/setup mein losses concentrate hain, entries pivot se door toh nahi, targets realistic hain ya nahi) and give 2 actionable rules for future trades. Max 180 words, simple language.\n\nClosed trades:\n${closed.slice(-25).map(describe).join("\n")}`;
  }

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt });
    const text = (response.text || "").trim();
    if (!text) return res.json({ ok: false, error: "Gemini se khali response aaya, dobara try karo." });
    if (target) {
      target.aiReview = text;
      if (isPb) writePbTrades(trades); else writeTrades(trades);
    }
    res.json({ ok: true, review: text, tradeId: target?.id });
  } catch (e: any) {
    res.json({ ok: false, error: `Gemini call fail: ${e.message || e}` });
  }
});

// ==================== PLAYBACK (TIME MACHINE) ENGINE ====================
// Everything here answers ONE question honestly: "What did the world look like on
// date D?" — no information from after D ever reaches a response.

const PLAYBACK_DIR = path.join(process.cwd(), "data", "playback");
const OHLCV_DIR = path.join(process.cwd(), "data", "ohlcv");
const PB_TRADES_FILE = path.join(DATA_DIR, "playback_trades.json");

interface PbSignal { d: string; p: number; dp?: number; dm?: number; stop?: number; tgt?: number }
interface PbStrat { trades: any[]; signals: PbSignal[] }
interface PbStock { symbol: string; name: string; sector?: string; synthetic: boolean; strategies: Record<string, PbStrat> }

// In-memory playback DB — parsed once, invalidated when axis.json changes (fresh scan).
let pbDB: { stocks: PbStock[]; axis: string[]; mtime: number } | null = null;
function loadPlaybackDB(): { stocks: PbStock[]; axis: string[] } | null {
  try {
    const axisPath = path.join(PLAYBACK_DIR, "axis.json");
    if (!fs.existsSync(axisPath)) return null;
    const mtime = fs.statSync(axisPath).mtimeMs;
    if (pbDB && pbDB.mtime === mtime) return pbDB;
    const axis: string[] = JSON.parse(fs.readFileSync(axisPath, "utf8")).dates || [];
    const index: { symbol: string }[] = JSON.parse(fs.readFileSync(path.join(PLAYBACK_DIR, "index.json"), "utf8"));
    const stocks: PbStock[] = [];
    for (const e of index) {
      try {
        stocks.push(JSON.parse(fs.readFileSync(path.join(PLAYBACK_DIR, `${e.symbol}.json`), "utf8")));
      } catch { /* skip unreadable stock */ }
    }
    pbDB = { stocks, axis, mtime };
    return pbDB;
  } catch {
    return null;
  }
}

// Lazy candle loader (playback journal execution) with a small in-memory cache.
const candleCache = new Map<string, { d: string[]; o: number[]; h: number[]; l: number[]; c: number[] }>();
function loadCandles(symbol: string) {
  if (candleCache.has(symbol)) return candleCache.get(symbol)!;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, `${symbol}.json`), "utf8"));
    if (candleCache.size > 60) candleCache.clear(); // crude but effective memory cap
    candleCache.set(symbol, raw);
    return raw;
  } catch {
    return null;
  }
}
function candlesUpTo(symbol: string, asOf: string) {
  const raw = loadCandles(symbol);
  if (!raw) return null;
  const asOfShort = asOf.slice(0, 10); // normalize to YYYY-MM-DD
  const out: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (let i = 0; i < raw.d.length; i++) {
    if (raw.d[i].slice(0, 10) > asOfShort) break;
    out.push({ date: raw.d[i], open: raw.o[i], high: raw.h[i], low: raw.l[i], close: raw.c[i], volume: 0 });
  }
  return out;
}

// As-of-D stats from a full-history trade log. Correct because the backtest engine is
// strictly causal: every trade closed on/before D is identical to what a scan run ON
// date D would have produced.
function asOfStats(trades: any[], D: string) {
  const closed = trades.filter((t) => !t.forced && t.exitDate <= D).sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  const openPos = trades.find((t) => t.entryDate <= D && (t.exitDate > D || (t.forced && t.exitDate >= D))) || null;
  const n = closed.length;
  if (n === 0) {
    return { closed, openPos, numTrades: 0, winRatePct: 0, profitFactor: 1.0, avgReturnPct: 0, maxDrawdownPct: 0, lastEntryPrice: null, lastExitPrice: null, lastReturnPct: null, passedBase: false, passedStrict: false };
  }
  const wins = closed.filter((t) => t.returnPct > 0);
  const winRatePct = parseFloat(((wins.length / n) * 100).toFixed(1));
  const gp = wins.reduce((s: number, t: any) => s + t.returnPct, 0);
  const gl = Math.abs(closed.filter((t) => t.returnPct < 0).reduce((s: number, t: any) => s + t.returnPct, 0));
  const profitFactor = parseFloat((gl === 0 ? (gp > 0 ? NO_LOSS_PF_CAP : 1.0) : Math.min(gp / gl, NO_LOSS_PF_CAP)).toFixed(2));
  const avgReturnPct = parseFloat((closed.reduce((s: number, t: any) => s + t.returnPct, 0) / n).toFixed(2));
  let bal = 100, peak = 100, maxDD = 0;
  for (const t of closed) {
    bal *= 1 + t.returnPct / 100;
    if (bal > peak) peak = bal;
    maxDD = Math.max(maxDD, ((peak - bal) / peak) * 100);
  }
  const last = closed[n - 1];
  const passedBase = winRatePct >= 60 && profitFactor >= 2.0 && n >= 10;
  const passedStrict = passedBase && profitFactor >= 2.5 && n >= 15;
  return {
    closed, openPos, numTrades: n, winRatePct, profitFactor, avgReturnPct,
    maxDrawdownPct: parseFloat(maxDD.toFixed(1)),
    lastEntryPrice: Math.round(last.entryPrice), lastExitPrice: Math.round(last.exitPrice),
    lastReturnPct: last.returnPct, passedBase, passedStrict
  };
}

const STRAT_TEXT: Record<string, { label: string; entry: string; exit: string }> = {};
for (const s of STRATEGIES_POOL) STRAT_TEXT[s.id] = { label: s.label, entry: s.entry, exit: s.exit };

app.get("/api/playback/axis", (_req, res) => {
  const db = loadPlaybackDB();
  if (!db) return res.status(404).json({ ok: false, error: "Playback data nahi mili — pehle ek fresh scan chalao (naya engine playback files banata hai)." });
  res.json({ ok: true, dates: db.axis, start: db.axis[0], end: db.axis[db.axis.length - 1], stocks: db.stocks.length });
});

app.get("/api/playback/snapshot", (req, res) => {
  const db = loadPlaybackDB();
  if (!db) return res.status(404).json({ ok: false, error: "Playback data nahi mili — pehle ek fresh scan chalao." });
  const D = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(D)) return res.status(400).json({ ok: false, error: "date=YYYY-MM-DD chahiye" });

  // ±1% price proximity + 2-bar window signal finder (same rule as live scan)
  // Signals array is sorted by date. Find the most recent signal on or before D
  // that is within 2 bars of D AND within ±1% of current price (candlesUpTo last close).
  // ADX filter helper for playback — candles as-of D se proper ADX compute karo
  function adxAsOf(symbol: string, D: string): number {
    if (ADX_LIVE_FILTER <= 0) return 999; // filter off
    const candles = candlesUpTo(symbol, D);
    if (!candles || candles.length < 30) return 0;
    const p = 14;
    const n = candles.length;
    // Proper ADX matching scan.ts calculateADX
    const tr = new Array(n).fill(0);
    const pdm = new Array(n).fill(0);
    const ndm = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      const up = h - candles[i-1].high, dn = candles[i-1].low - l;
      pdm[i] = up > dn && up > 0 ? up : 0;
      ndm[i] = dn > up && dn > 0 ? dn : 0;
    }
    // Wilder smoothing
    const at = new Array(n).fill(0), ap = new Array(n).fill(0), an = new Array(n).fill(0);
    if (n > p) {
      at[p] = tr.slice(1, p+1).reduce((a,b)=>a+b,0);
      ap[p] = pdm.slice(1, p+1).reduce((a,b)=>a+b,0);
      an[p] = ndm.slice(1, p+1).reduce((a,b)=>a+b,0);
    }
    for (let i = p+1; i < n; i++) {
      at[i] = at[i-1] - at[i-1]/p + tr[i];
      ap[i] = ap[i-1] - ap[i-1]/p + pdm[i];
      an[i] = an[i-1] - an[i-1]/p + ndm[i];
    }
    const dx = new Array(n).fill(0);
    const adx = new Array(n).fill(0);
    for (let i = p; i < n; i++) {
      const pdi = at[i] > 0 ? 100*ap[i]/at[i] : 0;
      const ndi = at[i] > 0 ? 100*an[i]/at[i] : 0;
      dx[i] = pdi+ndi > 0 ? 100*Math.abs(pdi-ndi)/(pdi+ndi) : 0;
    }
    if (n > 2*p) {
      adx[2*p-1] = dx.slice(p, 2*p).reduce((a,b)=>a+b,0)/p;
    }
    for (let i = 2*p; i < n; i++) {
      adx[i] = (adx[i-1]*(p-1) + dx[i])/p;
    }
    return adx[n-1];
  }

  function findLiveSignal(signals: PbSignal[], symbol: string, D: string): PbSignal | undefined {
    const axis = db!.axis;
    const Dshort = D.slice(0, 10);
    const dIdx = axis.findIndex(d => d.slice(0,10) === Dshort);
    if (dIdx === -1) return undefined;
    const raw = db!.stocks.find((s) => s.symbol === symbol);
    const candles = raw ? candlesUpTo(symbol, D) : null;
    const currentPrice = candles && candles.length > 0 ? candles[candles.length - 1].close : null;
    for (let i = signals.length - 1; i >= 0; i--) {
      const sg = signals[i];
      const sgShort = sg.d.slice(0, 10);
      if (sgShort > Dshort) continue; // future signal — skip
      const sgIdx = axis.findIndex(d => d.slice(0,10) === sgShort);
      if (sgIdx === -1) continue;
      const barsAgo = dIdx - sgIdx;
      if (barsAgo > 2) break;
      // Signal day (barsAgo=0): always show — signal just formed
      // Entry day (barsAgo=1): always show — this is THE day to enter
      // Day after entry (barsAgo=2): show only if price near signal price
      if (barsAgo <= 1) return sg;
      if (barsAgo === 2 && currentPrice && sg.p) {
        const drift = Math.abs((currentPrice - sg.p) / sg.p) * 100;
        if (drift <= 2.0) return sg; // relaxed — 2 din purana signal
      }
    }
    return undefined;
  }

  // ADX-filtered live signal wrapper
  function findLiveSignalADX(signals: PbSignal[], symbol: string, D: string): PbSignal | undefined {
    const sig = findLiveSignal(signals, symbol, D);
    if (!sig) return undefined;
    if (ADX_LIVE_FILTER <= 0) return sig;
    const adx = adxAsOf(symbol, D);
    return adx >= ADX_LIVE_FILTER ? sig : undefined;
  }

  const mkRow = (st: PbStock, sid: string, stats: any, live: PbSignal | undefined, extra: any = {}) => ({
    symbol: st.symbol,
    name: st.name,
    strategyId: sid,
    strategyLabel: STRAT_TEXT[sid]?.label || extra.strategyLabel || sid,
    entryCond: extra.entryCond || STRAT_TEXT[sid]?.entry || "",
    exitCond: extra.exitCond || STRAT_TEXT[sid]?.exit || "",
    lastEntryPrice: stats.lastEntryPrice,
    lastExitPrice: stats.lastExitPrice,
    lastReturnPct: stats.lastReturnPct,
    winRatePct: stats.winRatePct,
    profitFactor: stats.profitFactor,
    numTrades: stats.numTrades,
    avgReturnPct: stats.avgReturnPct,
    maxDrawdownPct: stats.maxDrawdownPct,
    liveSignal: !!live,
    livePrice: live ? Math.round(live.p) : null,
    isSynthetic: st.synthetic,
    trades: stats.closed,
    openPosition: stats.openPos ? { entryDate: stats.openPos.entryDate, entryPrice: stats.openPos.entryPrice } : null,
    ...extra.fields
  });

  const module1Rows: any[] = [];
  const module6Rows: any[] = [];
  const module7Rows: any[] = [];

  for (const st of db.stocks) {
    const results: Record<string, any> = {};
    for (const sid of Object.keys(st.strategies)) {
      results[sid] = asOfStats(st.strategies[sid].trades, D);
    }

    // Module 1: best pool strategy as-of D
    let bestId = STRATEGIES_POOL[0].id;
    let best = results[bestId];
    for (const s of STRATEGIES_POOL) {
      const r = results[s.id];
      if (!r) continue;
      const better = (r.passedBase && !best.passedBase) ||
        (r.passedBase === best.passedBase && r.profitFactor > best.profitFactor) ||
        (r.passedBase === best.passedBase && r.profitFactor === best.profitFactor && r.winRatePct > best.winRatePct);
      if (better) { bestId = s.id; best = r; }
    }
    if (best.passedStrict) {
      const live = findLiveSignalADX(st.strategies[bestId].signals, st.symbol, D);
      module1Rows.push(mkRow(st, bestId, best, live, { fields: { liveStop: live?.stop ?? null, liveTarget: live?.tgt ?? null } }));
    }

    // Module 6: ConnorsRSI Scanner
    const m6 = st.strategies["m6_connors_rsi"] ? asOfStats(st.strategies["m6_connors_rsi"].trades, D) : null;
    const m6live = st.strategies["m6_connors_rsi"]?.signals
      ? findLiveSignalADX(st.strategies["m6_connors_rsi"].signals, st.symbol, D)
      : undefined;
    const m6passed = m6 && (m6live || (m6.numTrades >= M6_MIN_TRADES && m6.winRatePct >= M6_MIN_WIN_RATE && m6.profitFactor >= M6_MIN_PF));
    if (m6passed) {
      const inTargetSector = M6_SECTORS.has(st.sector || "");
      module6Rows.push(mkRow(st, "m6_connors_rsi", m6, m6live, {
        strategyLabel: "ConnorsRSI Oversold",
        entryCond: "Price > EMA(200) aur ConnorsRSI(3,2,100) < 15 — deeply oversold in confirmed uptrend",
        exitCond: "ConnorsRSI > 90 hone pe exit (emergency floor: -8% from entry)",
        fields: { inTargetSector, liveStop: null, liveTarget: null, hasChart: false }
      }));
    }

    // Module 7: Turtle Soup Scanner
    const m7 = st.strategies["m7_turtle_soup"] ? asOfStats(st.strategies["m7_turtle_soup"].trades, D) : null;
    const m7live = st.strategies["m7_turtle_soup"]?.signals
      ? findLiveSignal(st.strategies["m7_turtle_soup"].signals, st.symbol, D)
      : undefined;
    const m7passed = m7 && (m7live || (m7.numTrades >= TS_MIN_TRADES && m7.winRatePct >= TS_MIN_WIN_RATE && m7.profitFactor >= TS_MIN_PF));
    if (m7passed) {
      module7Rows.push(mkRow(st, "m7_turtle_soup", m7, m7live, {
        strategyLabel: "Turtle Soup",
        entryCond: `New 20-day low bana + previous 20-day low ${TS_MIN_GAP}+ sessions pehle tha → reversal buy stop above previous 20-day low`,
        exitCond: `Trailing stop: ${TS_TRAIL_ATR}× ATR below peak — automatic trail exit`,
        fields: { liveStop: null, liveTarget: null, hasChart: false }
      }));
    }
  }

  const liveCount = module1Rows.filter((r) => r.liveSignal).length + module6Rows.filter((r) => r.liveSignal).length + module7Rows.filter((r) => r.liveSignal).length;

  res.json({
    ok: true,
    date: D,
    counts: { module1: module1Rows.length, module6: module6Rows.filter((r) => r.liveSignal).length, module7: module7Rows.filter((r) => r.liveSignal).length },
    liveCount,
    module1: module1Rows,
    module6: module6Rows,
    module7: module7Rows,
  });
});

// ---------- Playback practice journal (completely separate from the real journal) ----------

function readPbTrades(): JournalTrade[] {
  try {
    if (!fs.existsSync(PB_TRADES_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(PB_TRADES_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function writePbTrades(trades: JournalTrade[]) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PB_TRADES_FILE, JSON.stringify(trades, null, 2));
}
// Never leak the future: relative to asOf, entries that haven't executed yet show as PENDING.
function pbView(t: JournalTrade, asOf: string) {
  if (t.entryDate > asOf) {
    return { ...t, status: "PENDING", entryPrice: null, stopPrice: null, targetPrice: null, exitPrice: null, exitDate: null, returnPct: null, currentPrice: null, unrealizedPct: null } as any;
  }
  return t;
}

app.get("/api/playback/trades", (req, res) => {
  const asOf = String(req.query.asOf || "9999-12-31");
  const trades = readPbTrades();
  trades.sort((a, b) => (a.status === "OPEN" ? 0 : 1) - (b.status === "OPEN" ? 0 : 1) || b.takenAt.localeCompare(a.takenAt));
  res.json({ trades: trades.map((t) => pbView(t, asOf)) });
});

// Take a practice trade ON a past signal date. Execution follows the engine's rule:
// entry at the NEXT session's open (decision locked at signal time — stop/target are
// percentages, so seeing the fill price changes nothing).
app.post("/api/playback/trades/take", (req, res) => {
  const b = req.body || {};
  const signalDate = String(b.signalDate || "");
  const stopPct = Number(b.stopPct), targetPct = Number(b.targetPct);
  if (!b.symbol || !/^\d{4}-\d{2}-\d{2}$/.test(signalDate)) return res.status(400).json({ ok: false, error: "symbol + signalDate chahiye" });
  if (!isFinite(stopPct) || stopPct <= 0 || stopPct >= 50) return res.status(400).json({ ok: false, error: "Stop% 0–50 ke beech do" });
  if (!isFinite(targetPct) || targetPct <= 0) return res.status(400).json({ ok: false, error: "Target% valid do" });

  const raw = loadCandles(String(b.symbol));
  if (!raw) return res.status(404).json({ ok: false, error: "Is stock ka candle data nahi mila — fresh scan chalao" });
  let entryIdx = -1;
  for (let i = 0; i < raw.d.length; i++) { if (raw.d[i] > signalDate) { entryIdx = i; break; } }
  if (entryIdx === -1) return res.status(400).json({ ok: false, error: "Signal dataset ke aakhri din ka hai — entry agle din hoti jo data mein nahi hai" });

  const entryPrice = raw.o[entryIdx];
  const trade: JournalTrade = {
    id: `pb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    symbol: String(b.symbol),
    name: b.name ? String(b.name) : undefined,
    strategyId: b.strategyId ? String(b.strategyId) : undefined,
    strategyLabel: b.strategyLabel ? String(b.strategyLabel) : undefined,
    module: b.module ? String(b.module) : undefined,
    takenAt: new Date().toISOString(),
    entryDate: raw.d[entryIdx],
    entryPrice: Math.round(entryPrice * 100) / 100,
    stopPrice: Math.round(entryPrice * (1 - stopPct / 100) * 100) / 100,
    targetPrice: Math.round(entryPrice * (1 + targetPct / 100) * 100) / 100,
    status: "OPEN",
    depthPct: isFinite(Number(b.depthPct)) ? Number(b.depthPct) : undefined,
    durationM: isFinite(Number(b.durationM)) ? Number(b.durationM) : undefined,
    note: `practice @ signal ${signalDate}`
  };
  const trades = readPbTrades();
  const dup = trades.find((t) => t.status === "OPEN" && t.symbol === trade.symbol && (t.strategyId || "") === (trade.strategyId || ""));
  if (dup) return res.status(409).json({ ok: false, error: `${trade.symbol} ka is strategy pe OPEN practice trade pehle se hai` });
  trades.push(trade);
  writePbTrades(trades);
  res.json({ ok: true, trade: pbView(trade, signalDate) });
});

// Resolve open practice trades using candles up to (and including) asOfDate ONLY.
app.post("/api/playback/trades/check", (req, res) => {
  const asOf = String((req.body || {}).asOfDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return res.status(400).json({ ok: false, error: "asOfDate chahiye" });
  const trades = readPbTrades();
  let updated = 0;
  for (const t of trades) {
    if (t.status !== "OPEN" || t.entryDate > asOf) continue;
    const candles = candlesUpTo(t.symbol, asOf);
    if (!candles || !candles.length) continue;
    const out = evaluateTradeOutcome(t.entryDate, t.entryPrice, t.stopPrice, t.targetPrice, candles);
    if (out.status === "OPEN") {
      t.currentPrice = out.currentPrice;
      t.unrealizedPct = out.currentPrice ? parseFloat((((out.currentPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2)) : undefined;
    } else {
      t.status = out.status;
      t.exitPrice = parseFloat((out.exitPrice as number).toFixed(2));
      t.exitDate = out.exitDate;
      t.returnPct = parseFloat((((t.exitPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2));
      t.currentPrice = undefined;
      t.unrealizedPct = undefined;
      updated++;
    }
  }
  writePbTrades(trades);
  res.json({ ok: true, updated, trades: trades.map((t) => pbView(t, asOf)) });
});

// Manual exit in playback = exit at the CLOSE of the current playback day (no cherry-picking prices).
app.post("/api/playback/trades/close", (req, res) => {
  const { id, asOfDate } = req.body || {};
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || ""))) return res.status(400).json({ ok: false, error: "id + asOfDate chahiye" });
  const trades = readPbTrades();
  const t = trades.find((x) => x.id === id);
  if (!t) return res.status(404).json({ ok: false, error: "trade nahi mila" });
  if (t.status !== "OPEN") return res.status(400).json({ ok: false, error: "trade pehle se closed hai" });
  if (t.entryDate > asOfDate) return res.status(400).json({ ok: false, error: "Entry abhi hui hi nahi (PENDING) — pehle din aage badhao" });
  const candles = candlesUpTo(t.symbol, asOfDate);
  const last = candles && candles.length ? candles[candles.length - 1] : null;
  if (!last) return res.status(404).json({ ok: false, error: "candle data nahi mila" });
  t.status = "CLOSED_MANUAL";
  t.exitPrice = Math.round(last.close * 100) / 100;
  t.exitDate = last.date;
  t.returnPct = parseFloat((((t.exitPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(2));
  t.currentPrice = undefined;
  t.unrealizedPct = undefined;
  writePbTrades(trades);
  res.json({ ok: true, trade: t });
});

app.post("/api/playback/trades/delete", (req, res) => {
  const { id } = req.body || {};
  const trades = readPbTrades();
  const next = trades.filter((t) => t.id !== id);
  if (next.length === trades.length) return res.status(404).json({ ok: false, error: "trade nahi mila" });
  writePbTrades(next);
  res.json({ ok: true });
});

app.post("/api/playback/trades/reset", (_req, res) => {
  writePbTrades([]);
  res.json({ ok: true });
});

// LOCAL DEV ONLY: commit & push the freshly scanned public/cache so the deployed app can pick it up.
// Disabled in production (serverless containers have no git remote / credentials).
app.post("/api/publish", (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ ok: false, output: "Publish is disabled in production. Run it from local dev." });
  }

  // Check if .git exists to prevent 'fatal: not a git repository' error in workspace environments
  if (!fs.existsSync(path.join(process.cwd(), ".git"))) {
    return res.json({ 
      ok: false, 
      output: "No .git repository found in this workspace. Publishing (git push) is only supported in local development clones. Click 'Fetch Fresh Data' to use live data inside this session." 
    });
  }

  // `git diff --cached --quiet` skips an empty commit; push is a harmless no-op if nothing changed.
  const cmd = `git add public/cache && (git diff --cached --quiet || git commit -m "chore: refresh scan cache") && git push`;
  exec(cmd, { cwd: process.cwd() }, (err, stdout, stderr) => {
    const output = ((stdout || "") + (stderr || "")).trim().slice(-1800);
    if (err) return res.json({ ok: false, output: output || err.message });
    res.json({ ok: true, output: output || "Cache published." });
  });
});

async function start() {
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }
  
  app.listen(PORT, "0.0.0.0", () => console.log(`Edge console → http://localhost:${PORT}`));
  scheduleAutoScan();

  // Production: auto-start scan on boot if cache is missing
  // This handles Render free tier restarts where ephemeral filesystem wipes cache
  if (process.env.NODE_ENV === "production") {
    const cacheDir = path.join(process.cwd(), "public", "cache");
    const metaFile = path.join(cacheDir, "meta.json");
    if (!fs.existsSync(metaFile)) {
      console.log("🔄 Cache missing on startup — auto-starting scan...");
      setTimeout(() => {
        if (!scanStatus.isScanning) {
          scanStatus = {
            isScanning: true, progress: 0, scanned: 0,
            currentSymbol: "Auto-scan on startup...", passedCount: 0,
            logs: ["🚀 Auto-scan triggered: cache was empty on server start"]
          };
          runScan((progress, scanned, currentSymbol, passedCount, logLine) => {
            scanStatus.progress = progress; scanStatus.scanned = scanned;
            scanStatus.currentSymbol = currentSymbol; scanStatus.passedCount = passedCount;
            scanStatus.logs.push(logLine);
            if (scanStatus.logs.length > 80) scanStatus.logs.shift();
          }).then(() => {
            scanStatus.isScanning = false; scanStatus.progress = 100;
            scanStatus.logs.push("🎉 Startup scan complete — dashboard ready.");
          }).catch((err) => {
            scanStatus.isScanning = false;
            scanStatus.logs.push(`❌ Startup scan failed: ${err?.message || err}`);
          });
        }
      }, 3000); // 3s delay so server is fully up before scan starts
    }
  }
}


// ============================================================================
// /api/compare — "signal-close (3:25) entry" vs "next-open entry" comparison.
// Browser mein kholo: /api/compare  (pehle ek scan chala hua hona chahiye)
// ============================================================================
app.get("/api/compare", (_req, res) => {
  try {
    const OHLCV_DIR2 = path.join(process.cwd(), "data", "ohlcv");
    const PB_DIR2 = path.join(process.cwd(), "data", "playback");
    if (!fs.existsSync(OHLCV_DIR2) || !fs.existsSync(PB_DIR2)) {
      res.type("text/plain").send("❌ Playback data nahi mila. Pehle app mein 'Fetch Fresh Data' scan chalao (server restart ke baad data dobara banana ptda hai), phir ye page refresh karo.");
      return;
    }
    const COST2 = 0.2;
    const pfC = (rets: number[]) => { let gw = 0, gl = 0; for (const r of rets) r > 0 ? (gw += r) : (gl += -r); return gl === 0 ? (rets.length ? 10 : 0) : Math.min(10, gw / gl); };
    const aggC = (rets: number[]) => ({ n: rets.length, win: rets.length ? (100 * rets.filter((r) => r > 0).length) / rets.length : 0, avg: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0, pf: pfC(rets) });
    const byStrat: Record<string, { close: number[]; nextOpen: number[]; gaps: number[] }> = {};
    let stocksUsed = 0, tradesUsed = 0, skippedSyn = 0, minD = "9999", maxD = "0000";

    for (const f of fs.readdirSync(PB_DIR2)) {
      if (!f.endsWith(".json") || f === "axis.json" || f === "index.json") continue;
      const st = JSON.parse(fs.readFileSync(path.join(PB_DIR2, f), "utf8"));
      if (st.synthetic || st.isSynthetic) { skippedSyn++; continue; }
      const rp = path.join(OHLCV_DIR2, `${st.symbol}.json`);
      if (!fs.existsSync(rp)) continue;
      const raw = JSON.parse(fs.readFileSync(rp, "utf8"));
      const idx: Record<string, number> = {};
      raw.d.forEach((d: string, i: number) => (idx[d] = i));
      let used = false;
      for (const sid of Object.keys(st.strategies || {})) {
        for (const t of st.strategies[sid].trades || []) {
          if (t.forced) continue;
          const ei = idx[t.entryDate];
          if (ei === undefined || ei < 1) continue;
          const sc = raw.c[ei - 1], no = raw.o[ei];
          if (!sc || !no || Math.abs(no - t.entryPrice) / t.entryPrice > 0.005) continue;
          let rNO: number | null, rCL: number | null;
          if (sid === "m2_rounding_bottom") {
            const sim = (entry: number, sb: number): number | null => {
              const stop = entry * 0.95, tgt = entry * 1.15;
              for (let i = sb; i < raw.d.length; i++) {
                if (raw.o[i] <= stop) return ((raw.o[i] - entry) / entry) * 100 - COST2;
                if (raw.l[i] <= stop) return ((stop - entry) / entry) * 100 - COST2;
                if (raw.o[i] >= tgt) return ((raw.o[i] - entry) / entry) * 100 - COST2;
                if (raw.h[i] >= tgt) return ((tgt - entry) / entry) * 100 - COST2;
              }
              return null;
            };
            rNO = sim(no, ei + 1); rCL = sim(sc, ei);
            if (rNO === null || rCL === null) continue;
          } else {
            rNO = t.returnPct;
            rCL = ((t.exitPrice - sc) / sc) * 100 - COST2;
          }
          const b = (byStrat[sid] = byStrat[sid] || { close: [], nextOpen: [], gaps: [] });
          b.nextOpen.push(rNO!); b.close.push(rCL!); b.gaps.push(((no - sc) / sc) * 100);
          tradesUsed++; used = true;
          if (t.entryDate < minD) minD = t.entryDate;
          if (t.entryDate > maxD) maxD = t.entryDate;
        }
      }
      if (used) stocksUsed++;
    }

    if (!tradesUsed) { res.type("text/plain").send("❌ Real-data trades nahi mile (synthetic skip hote hain). Fresh scan chala ke dobara try karo."); return; }
    const fmtN = (x: number, w = 7, d = 2) => x.toFixed(d).padStart(w);
    const L: string[] = [];
    L.push("ENTRY STYLE COMPARISON — real scan data");
    L.push(`${stocksUsed} stocks | ${tradesUsed} trades | ${minD} -> ${maxD} | costs ${COST2}%/trade${skippedSyn ? ` | ${skippedSyn} synthetic skipped` : ""}`);
    L.push("=".repeat(100));
    L.push("STRATEGY".padEnd(24) + "N".padStart(6) + " | CLOSE(3:25): win%   avg%     PF | NEXT-OPEN:  win%   avg%     PF | avgGAP%  gapUp%");
    L.push("-".repeat(100));
    const aC: number[] = [], aO: number[] = [], aG: number[] = [];
    for (const sid of Object.keys(byStrat).sort()) {
      const b = byStrat[sid], c = aggC(b.close), o = aggC(b.nextOpen);
      const g = b.gaps.reduce((a, x) => a + x, 0) / b.gaps.length;
      const gu = (100 * b.gaps.filter((x) => x > 0).length) / b.gaps.length;
      L.push(sid.padEnd(24) + String(c.n).padStart(6) + " |            " + fmtN(c.win, 6, 1) + fmtN(c.avg) + fmtN(c.pf) + " |           " + fmtN(o.win, 6, 1) + fmtN(o.avg) + fmtN(o.pf) + " |" + fmtN(g, 8, 3) + fmtN(gu, 8, 1));
      aC.push(...b.close); aO.push(...b.nextOpen); aG.push(...b.gaps);
    }
    L.push("-".repeat(100));
    const tc = aggC(aC), to = aggC(aO);
    L.push("OVERALL".padEnd(24) + String(tc.n).padStart(6) + " |            " + fmtN(tc.win, 6, 1) + fmtN(tc.avg) + fmtN(tc.pf) + " |           " + fmtN(to.win, 6, 1) + fmtN(to.avg) + fmtN(to.pf) + " |" + fmtN(aG.reduce((a, x) => a + x, 0) / aG.length, 8, 3) + fmtN((100 * aG.filter((x) => x > 0).length) / aG.length, 8, 1));
    L.push("=".repeat(100));
    L.push("CLOSE(3:25) = signal-day close entry | NEXT-OPEN = engine default | m2 dono full re-simulated, indicator exits identical");
    res.type("text/plain").send(L.join("\n"));
  } catch (e: any) {
    res.type("text/plain").send("❌ Compare error: " + (e?.message || e));
  }
});

// ============================================================================
// /api/divergence/chart?symbol=X&asOf=YYYY-MM-DD — chart payload for the visual
// divergence viewer: candles + RSI + marked divergence events. asOf (playback)
// pe data clip hota hai taaki time-machine mein future leak na ho.
// ============================================================================
app.get("/api/divergence/chart", (req, res) => {
  try {
    const symbol = String(req.query.symbol || "");
    if (!symbol || symbol.includes("/") || symbol.includes("..")) return res.status(400).json({ ok: false, error: "valid symbol chahiye" });
    const fp = path.join(process.cwd(), "data", "ohlcv", `${symbol}.json`);
    if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: "Is stock ka candle data nahi mila — fresh scan chalao." });
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));

    // asOf clip (playback ke liye)
    const asOf = String(req.query.asOf || "");
    let end = raw.d.length;
    if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      end = raw.d.findIndex((d: string) => d > asOf);
      if (end === -1) end = raw.d.length;
    }
    const daily = raw.d.slice(0, end).map((d: string, i: number) => ({ date: d, open: raw.o[i], high: raw.h[i], low: raw.l[i], close: raw.c[i], volume: raw.v?.[i] ?? 0 }));
    // m4 WEEKLY pe chalta hai — chart bhi weekly dikhna chahiye, warna pivots/events
    // backtest se match nahi karenge.
    const ohlcv = toWeekly(daily);
    if (ohlcv.length < 60) return res.status(400).json({ ok: false, error: "Chart ke liye data kam hai" });

    const closes = ohlcv.map((c: any) => c.close);
    const rsi = calculateRSI(closes, 14);
    const events = detectDivergences(ohlcv.map((c: any) => c.date), ohlcv.map((c: any) => c.high), ohlcv.map((c: any) => c.low), rsi, ohlcv);

    // Window: last 200 WEEKLY bars (~4 saal), par kam se kam latest divergence pura dikhe
    const N = ohlcv.length;
    let startIdx = Math.max(0, N - 200);
    const lastEv = events[events.length - 1];
    if (lastEv && lastEv.p1.i < startIdx) startIdx = Math.max(0, lastEv.p1.i - 10);
    const win = (i: number) => i - startIdx;

    const evOut = events
      .filter((e) => e.p1.i >= startIdx)
      .slice(-12) // chart pe zyada se zyada 12 latest events (clutter na ho)
      .map((e) => ({
        type: e.type,
        confirmDate: e.confirmDate,
        p1: { x: win(e.p1.i), d: e.p1.d, price: e.p1.price, rsi: e.p1.rsi },
        p2: { x: win(e.p2.i), d: e.p2.d, price: e.p2.price, rsi: e.p2.rsi },
        confirmX: win(e.confirmIdx)
      }));

    res.json({
      ok: true,
      symbol,
      asOf: asOf || null,
      dates: ohlcv.slice(startIdx).map((c: any) => c.date),
      closes: closes.slice(startIdx).map((x: number) => Math.round(x * 100) / 100),
      opens: ohlcv.slice(startIdx).map((c: any) => Math.round(c.open * 100) / 100),
      highs: ohlcv.slice(startIdx).map((c: any) => Math.round(c.high * 100) / 100),
      lows: ohlcv.slice(startIdx).map((c: any) => Math.round(c.low * 100) / 100),
      rsi: rsi.slice(startIdx).map((x: number) => Math.round((x || 50) * 10) / 10),
      events: evOut
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ============================================================================
// /api/compare-sl — SL/target exit-scheme comparison (dashboard-safe, read-only).
// Poore live universe (ya ?limit=N) pe M1+M3 same entries, 7 exit schemes test
// karta hai. Background job (500 stocks me time lagta hai) — is route se sirf
// START/STATUS milta hai, result /api/compare-sl/result se poll karo.
//   GET /api/compare-sl/start?limit=500   -> { ok, started }
//   GET /api/compare-sl/status            -> { running, done, total, currentSymbol }
//   GET /api/compare-sl/result            -> { ok, ...CompareResult } (jab tak nahi bana: { ok:false, pending:true })
// ============================================================================
let compareSlJob: {
  running: boolean;
  done: number;
  total: number;
  currentSymbol: string;
  startedAt: number;
  result: any | null;
  error: string | null;
} = { running: false, done: 0, total: 0, currentSymbol: "", startedAt: 0, result: null, error: null };

app.get("/api/compare-sl/start", async (req, res) => {
  if (compareSlJob.running) {
    return res.json({ ok: true, started: false, alreadyRunning: true });
  }
  const limitRaw = String(req.query.limit || "");
  const limit = /^\d+$/.test(limitRaw) ? Number(limitRaw) : null;

  compareSlJob = { running: true, done: 0, total: 0, currentSymbol: "", startedAt: Date.now(), result: null, error: null };
  res.json({ ok: true, started: true });

  // Background — response already sent above, this continues after.
  (async () => {
    try {
      const log = (_m: string) => {}; // loadNifty500Tickers wants a logger; we don't need console noise here
      let universe = await loadNifty500Tickers(log);
      if (limit && limit > 0) universe = universe.slice(0, limit);
      compareSlJob.total = universe.length;
      const result = await runCompareSl(universe, (done, total, sym) => {
        compareSlJob.done = done;
        compareSlJob.total = total;
        compareSlJob.currentSymbol = sym;
      });
      compareSlJob.result = result;
    } catch (e: any) {
      compareSlJob.error = e?.message || String(e);
    } finally {
      compareSlJob.running = false;
    }
  })();
});

app.get("/api/compare-sl/status", (_req, res) => {
  res.json({
    running: compareSlJob.running,
    done: compareSlJob.done,
    total: compareSlJob.total,
    currentSymbol: compareSlJob.currentSymbol,
    elapsedSec: compareSlJob.startedAt ? +((Date.now() - compareSlJob.startedAt) / 1000).toFixed(1) : 0,
    hasResult: !!compareSlJob.result,
    error: compareSlJob.error,
  });
});

app.get("/api/compare-sl/result", (_req, res) => {
  if (compareSlJob.error) return res.json({ ok: false, error: compareSlJob.error });
  if (!compareSlJob.result) return res.json({ ok: false, pending: true, running: compareSlJob.running, done: compareSlJob.done, total: compareSlJob.total });
  res.json(compareSlJob.result);
});

start();