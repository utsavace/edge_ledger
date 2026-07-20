// ============================================================================
// compare-sl-cli.ts — Standalone terminal-based comparative backtester
// ----------------------------------------------------------------------------
// Run: npm run compare-sl
// Or:  npm run compare-sl -- --limit=50
// ============================================================================

import { runCompareSl } from "./compareSlEngine.ts";
import fs from "fs";
import path from "path";

async function main() {
  console.clear();
  console.log("\x1b[35m%s\x1b[0m", "============================================================================");
  console.log("\x1b[35m%s\x1b[0m", "            EDGE.LEDGER — STOP LOSS & EXIT SCHEME COMPARISON CLI            ");
  console.log("\x1b[35m%s\x1b[0m", "============================================================================");

  // Parse arguments
  let limit = 30; // default to 30 for rapid scanning
  for (const arg of process.argv) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.split("=")[1], 10);
    }
  }

  // Load active universe
  const pbIndex = path.join(process.cwd(), "data", "playback", "index.json");
  let universe: { symbol: string; name: string }[] = [];
  if (fs.existsSync(pbIndex)) {
    universe = JSON.parse(fs.readFileSync(pbIndex, "utf8"));
  } else {
    universe = [
      { symbol: "RELIANCE.NS", name: "Reliance Industries Limited" },
      { symbol: "TCS.NS", name: "Tata Consultancy Services Limited" },
      { symbol: "HDFCBANK.NS", name: "HDFC Bank Limited" },
      { symbol: "INFY.NS", name: "Infosys Limited" },
      { symbol: "ICICIBANK.NS", name: "ICICI Bank Limited" },
      { symbol: "ITC.NS", name: "ITC Limited" },
      { symbol: "SBIN.NS", name: "State Bank of India" },
      { symbol: "BHARTIARTL.NS", name: "Bharti Airtel Limited" },
      { symbol: "TATAMOTORS.NS", name: "Tata Motors Limited" },
      { symbol: "HINDUNILVR.NS", name: "Hindustan Unilever Limited" }
    ];
    console.log("\x1b[33m%s\x1b[0m", "⚠️  Playback index.json not found. Falling back to default list of Nifty leaders.");
  }

  const requestedCount = limit > 0 ? Math.min(limit, universe.length) : universe.length;
  const activeUniverse = limit > 0 ? universe.slice(0, limit) : universe;

  console.log(`\x1b[36mRunning simulation on %d stocks...\x1b[0m`, requestedCount);
  console.log(`Parallel batching: 12 workers. Local data checked first. Please wait...`);

  const result = await runCompareSl(activeUniverse, (done, total, sym) => {
    // Print in-line spinner progress
    const pct = Math.round((done / total) * 100);
    process.stdout.write(`\r[${"#".repeat(Math.round(pct / 5)).padEnd(20)}] ${pct}% - Processing: ${sym.padEnd(12)}`);
  });

  process.stdout.write("\r" + " ".repeat(80) + "\r"); // clear progress line

  console.log("\n\x1b[32m%s\x1b[0m", "✓ Simulations Completed successfully!");
  console.log(`- Stocks analyzed: ${result.universeUsed} / ${result.universeRequested}`);
  console.log(`- Time elapsed: ${result.elapsedSec} seconds`);

  // Print results for each strategy
  for (const strat of result.strategies) {
    console.log("\n" + "=".repeat(110));
    console.log(`\x1b[1m\x1b[33mSTRATEGY: ${strat.label.toUpperCase()}\x1b[0m`);
    console.log("-".repeat(110));

    // Print Table Headers
    const pad = (s: string, w: number, right = false) => {
      const padSize = w - s.length;
      if (padSize <= 0) return s.substring(0, w);
      return right ? " ".repeat(padSize) + s : s + " ".repeat(padSize);
    };

    console.log(
      `| ${pad("Exit Scheme", 40)} | ${pad("Trades", 6, true)} | ${pad("WinRate", 7, true)} | ${pad("ProfFact", 8, true)} | ${pad("AvgRet", 8, true)} | ${pad("Expect", 7, true)} | ${pad("MaxDD", 7, true)} | ${pad("PlannedR:R", 11, true)} |`
    );
    console.log("|" + "-".repeat(42) + "|" + "-".repeat(8) + "|" + "-".repeat(9) + "|" + "-".repeat(10) + "|" + "-".repeat(10) + "|" + "-".repeat(9) + "|" + "-".repeat(9) + "|" + "-".repeat(13) + "|");

    for (const sc of strat.schemes) {
      const isBest = strat.best?.key === sc.key;
      const isCurrent = sc.key === "IND";
      let name = sc.label;
      if (isCurrent) name = `[CURRENT] ${name}`;
      if (isBest) name = `★ ${name}`;

      const rowText = `| ${pad(name, 40)} | ${pad(String(sc.trades), 6, true)} | ${pad(`${sc.winRatePct}%`, 7, true)} | ${pad(sc.profitFactor.toFixed(2), 8, true)} | ${pad(`${sc.avgReturnPct > 0 ? "+" : ""}${sc.avgReturnPct}%`, 8, true)} | ${pad(`${sc.expectancyPct > 0 ? "+" : ""}${sc.expectancyPct}%`, 7, true)} | ${pad(`-${sc.maxDrawdownPct}%`, 7, true)} | ${pad(sc.avgPlannedRR ? `${sc.avgPlannedRR}:1` : "Ind-based", 11, true)} |`;
      
      if (isBest) {
        console.log(`\x1b[32m${rowText}\x1b[0m`); // green for best
      } else if (isCurrent) {
        console.log(`\x1b[36m${rowText}\x1b[0m`); // cyan for current
      } else {
        console.log(rowText);
      }
    }
    console.log("=".repeat(110));

    if (strat.best) {
      console.log(`\x1b[33m💡 Verdict: ${strat.best.reason}\x1b[0m`);
    }
  }

  console.log(`\n\x1b[90mNote: ${result.note}\x1b[0m\n`);
}

main().catch((err) => {
  console.error("❌ CLI Execution error:", err);
  process.exit(1);
});
