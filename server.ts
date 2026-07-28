import express from "express";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import dotenv from "dotenv";
import { runScan, NO_LOSS_PF_CAP, fetchStockData, evaluateTradeOutcome, type JournalTrade, calculateRSI, loadNifty500Tickers, backtestConnorsRSI, M6_MIN_TRADES, M6_MIN_WIN_RATE, M6_MIN_PF, M6_SECTORS, ADX_LIVE_FILTER } from "./scan.ts";

// Load env for GEMINI_API_KEY (README uses .env.local; AI Studio injects at runtime)
dotenv.config({ path: ".env.local" });
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const CACHE = path.join(process.cwd(), "public", "cache");

// ---------- Personal trade journal storage ----------
// Primary: Google Sheets (persistent across restarts)
// Fallback: Local JSON file (agar Sheets unavailable ho)
const DATA_DIR = path.join(process.cwd(), "data");
const TRADES_FILE = path.join(DATA_DIR, "mytrades.json");
const SHEETS_URL = process.env.GOOGLE_SHEET_URL || "";

// ── Google Sheets helpers ─────────────────────────────────
async function sheetsRequest(body: object): Promise<any> {
  if (!SHEETS_URL) return null;
  try {
    const res = await (globalThis as any).fetch(SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function sheetsGet(): Promise<any> {
  if (!SHEETS_URL) return null;
  try {
    const res = await (globalThis as any).fetch(`${SHEETS_URL}?action=list`, {
      signal: AbortSignal.timeout(8000)
    });
    return await res.json();
  } catch {
    return null;
  }
}

// ── Local file helpers (fallback) ────────────────────────
function readLocalTrades(): JournalTrade[] {
  try {
    if (!fs.existsSync(TRADES_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalTrades(trades: JournalTrade[]) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

// ── Main trade functions (Sheets first, local fallback) ───
async function readTrades(): Promise<JournalTrade[]> {
  if (SHEETS_URL) {
    const data = await sheetsGet();
    if (data?.trades) {
      // Local mein bhi save karo as cache
      writeLocalTrades(data.trades);
      return data.trades;
    }
  }
  // Fallback to local
  return readLocalTrades();
}

async function writeTrades(trades: JournalTrade[]) {
  // Local mein hamesha save karo
  writeLocalTrades(trades);
  // Google Sheets mein bhi save karo
  if (SHEETS_URL) {
    await sheetsRequest({ action: "saveAll", trades });
  }
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

// FIX: Use Intl.DateTimeFormat for robust IST timezone handling
// Previous approach (manual +5.5h offset) worked but was fragile and confusing.
// Intl.DateTimeFormat with 'Asia/Kolkata' is the correct, self-documenting approach.
function isAutoScanWindowIST(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday:  'short',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).formatToParts(now);

  const weekday = parts.find(p => p.type === 'weekday')?.value || '';
  const hour    = parseInt(parts.find(p => p.type === 'hour')?.value   || '0', 10);
  const minute  = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const mins = hour * 60 + minute;
  const MARKET_OPEN    = 9 * 60 + 15;  // 9:15 AM IST
  const REFRESH_CUTOFF = 16 * 60;      // 4:00 PM IST
  return mins >= MARKET_OPEN && mins <= REFRESH_CUTOFF;
}

function scheduleAutoScan() {
  if (process.env.NODE_ENV !== "production") return; // AI Studio dev sandbox: manual button only
  setInterval(() => {
    if (scanStatus.isScanning) return; // never overlap with an in-progress scan
    if (!isAutoScanWindowIST()) return;

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
    const minT = n === "6" ? M6_MIN_TRADES : isStrictModule ? strictT : baseT;
    const minPF = n === "6" ? M6_MIN_PF : isStrictModule ? strictPF : basePF;
    const minWRCheck = n === "6" ? M6_MIN_WIN_RATE : minWR;

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
app.get("/api/trades", async (_req, res) => {
  const trades = await readTrades();
  trades.sort((a, b) => (a.status === "OPEN" ? 0 : 1) - (b.status === "OPEN" ? 0 : 1) || b.takenAt.localeCompare(a.takenAt));
  res.json({ trades });
});

// Tick "I'm taking this trade" — freezes entry/SL/target at this moment
app.post("/api/trades/take", async (req, res) => {
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
  const trades = await readTrades();
  // Duplicate guard: same symbol + strategy already OPEN → double tick roka
  const dup = trades.find((t) => t.status === "OPEN" && t.symbol === trade.symbol && (t.strategyId || "") === (trade.strategyId || ""));
  if (dup) return res.status(409).json({ ok: false, error: `${trade.symbol} ka is strategy pe ek OPEN trade pehle se journal mein hai (${dup.entryDate})` });
  trades.push(trade);
  await writeTrades(trades);
  res.json({ ok: true, trade });
});

// Auto-check every OPEN trade against fresh Yahoo candles: SL hit? Target hit? Still running?
app.post("/api/trades/check", async (_req, res) => {
  const trades = await readTrades();
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
  await writeTrades(trades);
  res.json({ ok: true, updated, failedSymbols: failed, trades });
});

// Manually close a trade (user exited on their own) at a given price
app.post("/api/trades/close", async (req, res) => {
  const { id, exitPrice } = req.body || {};
  const px = Number(exitPrice);
  if (!id || !isFinite(px) || px <= 0) return res.status(400).json({ ok: false, error: "id aur valid exitPrice chahiye" });
  const trades = await readTrades();
  const t = trades.find((x) => x.id === id);
  if (!t) return res.status(404).json({ ok: false, error: "trade nahi mila" });
  if (t.status !== "OPEN") return res.status(400).json({ ok: false, error: "trade pehle se closed hai" });
  t.status = "CLOSED_MANUAL";
  t.exitPrice = parseFloat(px.toFixed(2));
  t.exitDate = new Date().toISOString().slice(0, 10);
  t.returnPct = parseFloat((((px - t.entryPrice) / t.entryPrice) * 100).toFixed(2));
  t.currentPrice = undefined;
  t.unrealizedPct = undefined;
  await writeTrades(trades);
  res.json({ ok: true, trade: t });
});

// Delete a journal entry
app.post("/api/trades/delete", async (req, res) => {
  const { id } = req.body || {};
  const trades = await readTrades();
  const next = trades.filter((t) => t.id !== id);
  if (next.length === trades.length) return res.status(404).json({ ok: false, error: "trade nahi mila" });
  await writeTrades(next);
  res.json({ ok: true });
});

// Exit signal checker — open trades ke liye indicator-based exit signal check karo
app.get("/api/trades/exit-signals", async (_req, res) => {
  try {
    const trades = (await readTrades()).filter((t: any) => t.status === "OPEN");
    const results: Record<string, { signal: boolean; reason: string; crsi?: number; stochK?: number; rsi?: number }> = {};

    for (const t of trades) {
      const sid = t.strategyId || "";
      const sym = t.symbol;

      try {
        const ohlcv = await fetchStockData(`${sym}.NS`, 200);
        const closes: number[] = ohlcv.map((c: any) => c.close);
        const dates: string[] = ohlcv.map((c: any) => c.date);
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
  const { id, journal } = req.body || {};  const trades = await readTrades();
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
      target.aiReview = text; else await writeTrades(trades);
    }
    res.json({ ok: true, review: text, tradeId: target?.id });
  } catch (e: any) {
    res.json({ ok: false, error: `Gemini call fail: ${e.message || e}` });
  }
});


// ============================================================================

// ============================================================================

start();
