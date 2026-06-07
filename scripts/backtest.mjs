// Model scorecard / backtest harness. Scores MultiPick's logged predictions
// against what actually happened — the "are our numbers any good?" report.
//
// For every prediction in grid_build_predictions we resolve the outcome by
// joining to *_player_games (the player's first game on/after the prediction
// date, exactly like recalibrate.mjs), then compute proper scoring metrics:
//
//   • Brier score  — mean((pred − actual)²). Lower is better. 0 = perfect.
//   • Log loss     — penalises confident wrongness harder than Brier.
//   • Calibration  — ECE (expected calibration error) + a reliability table:
//                    "legs we rated 80% actually hit X%".
//   • Skill        — Brier Skill Score vs two baselines:
//                    (a) base rate (always predict the average hit rate)
//                    (b) the market (1/odds at build time)
//                    BSS > 0 means we beat that baseline.
//   • Sharpness    — how far our predictions spread from the base rate.
//
// Reported overall, for SELECTED legs only (real picks users could bet), and
// broken down by sport and market. This is the measurement tool: run it before
// and after a model change to see whether the change actually helped.
//
// Env: SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
// Run: node scripts/backtest.mjs

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// Local convenience: load .env so `npm run backtest` works without sourcing it
// first. Skipped when the vars are already set (e.g. CI passes them as real env
// vars and may have no .env file). Never overrides an existing value.
if (!process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL) {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]]) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch { /* no .env — rely on real env vars */ }
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ── Sport / metric mapping (mirrors recalibrate.mjs) ───────────────────────
const AFL_METRICS = new Set([
  "disposals", "goals", "marks", "kicks", "handballs",
  "tackles", "hitouts", "clearances", "behinds", "fantasy_points",
]);
const NBA_METRIC_MAP = {
  pts: "pts", points: "pts",
  reb: "reb", rebounds: "reb",
  ast: "ast", assists: "ast",
  fg3m: "fg3m", threes: "fg3m", three_pointers: "fg3m",
  stl: "stl", steals: "stl",
  blk: "blk", blocks: "blk",
};
function metricSport(metric) {
  if (AFL_METRICS.has(metric)) return "AFL";
  if (NBA_METRIC_MAP[metric]) return "NBA";
  return null;
}
function metricColumn(sport, metric) {
  if (sport === "AFL") return AFL_METRICS.has(metric) ? metric : null;
  if (sport === "NBA") return NBA_METRIC_MAP[metric] || null;
  return null;
}

// ── Data loading (paged) ───────────────────────────────────────────────────
async function fetchAllPredictions() {
  // closing_odds is a later migration — tolerate its absence so the scorecard
  // still runs (the CLV section just reports nothing) before it's applied.
  const probe = await supabase.from("grid_build_predictions").select("closing_odds").limit(1);
  const cols = "created_at,name_key,metric,line,predicted_prob,odds,selected" + (probe.error ? "" : ",closing_odds");

  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("grid_build_predictions")
      .select(cols)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function fetchActuals(table, columns, keys, minDate) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .in("name_key", keys)
      .gte("game_date", minDate)
      .order("game_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// Resolve predictions → samples { pred, actual, metric, odds, selected, sport }.
async function buildSamples(sport, preds) {
  if (!preds.length) return [];
  const table = sport === "AFL" ? "afl_player_games" : "nba_player_games";
  const sportCols = sport === "AFL" ? [...AFL_METRICS] : ["pts", "reb", "ast", "fg3m", "stl", "blk"];
  const cols = `name_key,game_date,${sportCols.join(",")}`;
  const keys = [...new Set(preds.map((p) => p.name_key))];
  const minDate = String(preds[0].created_at).slice(0, 10);

  const actuals = await fetchActuals(table, cols, keys, minDate);
  const byKey = new Map();
  for (const r of actuals) {
    if (!byKey.has(r.name_key)) byKey.set(r.name_key, []);
    byKey.get(r.name_key).push(r);
  }

  const samples = [];
  for (const p of preds) {
    const col = metricColumn(sport, p.metric);
    if (!col) continue;
    const predDate = String(p.created_at).slice(0, 10);
    const games = byKey.get(p.name_key) || [];
    const g = games.find((x) => x.game_date >= predDate && x[col] != null);
    if (!g) continue; // unresolved — game not scraped yet
    samples.push({
      pred: Number(p.predicted_prob),
      actual: Number(g[col]) >= Number(p.line) ? 1 : 0,
      metric: p.metric,
      odds: p.odds != null ? Number(p.odds) : null,
      selected: p.selected !== false,
      sport,
    });
  }
  return samples;
}

// ── Scoring ────────────────────────────────────────────────────────────────
const clip = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

function brier(samples, predOf) {
  return mean(samples.map((s) => (predOf(s) - s.actual) ** 2));
}
function logLoss(samples, predOf) {
  return -mean(samples.map((s) => {
    const p = clip(predOf(s));
    return s.actual * Math.log(p) + (1 - s.actual) * Math.log(1 - p);
  }));
}
// Expected Calibration Error + reliability table (deciles).
function reliability(samples, predOf, bins = 10) {
  const buckets = Array.from({ length: bins }, () => ({ n: 0, sumPred: 0, hits: 0 }));
  for (const s of samples) {
    const p = predOf(s);
    let idx = Math.floor(p * bins);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    buckets[idx].n += 1;
    buckets[idx].sumPred += p;
    buckets[idx].hits += s.actual;
  }
  const N = samples.length || 1;
  let ece = 0;
  const rows = [];
  buckets.forEach((b, i) => {
    if (!b.n) return;
    const predMean = b.sumPred / b.n;
    const actual = b.hits / b.n;
    ece += (b.n / N) * Math.abs(predMean - actual);
    rows.push({ band: `${i * 10}-${i * 10 + 10}%`, n: b.n, pred: predMean, actual });
  });
  return { ece, rows };
}
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}

function scoreBlock(label, samples) {
  if (!samples.length) {
    console.log(`\n${label}: no resolved samples.`);
    return;
  }
  const base = mean(samples.map((s) => s.actual)); // observed hit rate
  const bModel = brier(samples, (s) => s.pred);
  const bBase = brier(samples, () => base);
  const llModel = logLoss(samples, (s) => s.pred);

  // Market baseline only over samples that have odds.
  const withOdds = samples.filter((s) => s.odds && s.odds > 1);
  const bMarket = withOdds.length ? brier(withOdds, (s) => clip(1 / s.odds)) : null;
  const bModelOnOdds = withOdds.length ? brier(withOdds, (s) => s.pred) : null;

  const bssBase = 1 - bModel / (bBase || 1);
  const bssMarket = bMarket ? 1 - bModelOnOdds / bMarket : null;
  const { ece } = reliability(samples, (s) => s.pred);
  const sharp = stdev(samples.map((s) => s.pred));

  console.log(`\n${label}`);
  console.log(`  resolved          ${samples.length}   ·  base hit rate ${(base * 100).toFixed(1)}%`);
  console.log(`  Brier (model)     ${bModel.toFixed(4)}   (lower better; base-rate ${bBase.toFixed(4)})`);
  console.log(`  Brier skill       ${(bssBase * 100).toFixed(1)}%   vs base rate   ${bssBase > 0 ? "✓ adds skill" : "✗ no skill over guessing the average"}`);
  if (bMarket != null) {
    console.log(`  vs market (1/odds) model ${bModelOnOdds.toFixed(4)} vs market ${bMarket.toFixed(4)}  →  ${(bssMarket * 100).toFixed(1)}% ${bssMarket > 0 ? "✓ beats the book price" : "✗ worse than the raw price"}  (n=${withOdds.length}, market incl. vig)`);
  }
  console.log(`  Log loss (model)  ${llModel.toFixed(4)}`);
  console.log(`  Calibration ECE   ${(ece * 100).toFixed(2)}%   (avg gap between predicted and actual)`);
  console.log(`  Sharpness         ${(sharp * 100).toFixed(1)}%   (spread of predictions; ~0 = always guessing the average)`);
}

// CLV (Closing Line Value). Doesn't need the game result — it's available the
// moment closing odds are captured, so it's the fastest read on whether the
// model finds real edge. "Beating the close" = your build price was higher than
// the price the market closed at (you locked better value). Consistently
// beating the close (>~53% + positive avg CLV) is the strongest signal that the
// +EV is real and not noise.
function clvReport(label, rows) {
  const withBoth = rows.filter((r) => Number(r.odds) > 1 && Number(r.closing_odds) > 1);
  if (!withBoth.length) {
    console.log(`\n${label}: no closing odds yet — run db/grid_build_predictions_add_closing.sql, then the capture job fills them near kickoff.`);
    return;
  }
  const clvs = withBoth.map((r) => Number(r.odds) / Number(r.closing_odds) - 1); // fraction
  const beat = withBoth.filter((r) => Number(r.odds) > Number(r.closing_odds)).length;
  const avg = mean(clvs) * 100;
  const beatPct = (beat / withBoth.length) * 100;
  console.log(`\n${label}`);
  console.log(`  legs w/ closing   ${withBoth.length}`);
  console.log(`  beat the close    ${beatPct.toFixed(1)}%   (locked a better price than the market closed at)`);
  console.log(`  avg CLV           ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%   ${avg > 0 ? "✓ beating the market" : "✗ behind the market"}`);
}

function reliabilityTable(label, samples) {
  if (samples.length < 20) return;
  const { rows } = reliability(samples, (s) => s.pred);
  if (!rows.length) return;
  console.log(`\n${label} — reliability (predicted vs actual)`);
  console.log(`  band        n    predicted   actual    gap`);
  for (const r of rows) {
    const gap = r.actual - r.pred;
    console.log(
      `  ${r.band.padEnd(9)} ${String(r.n).padStart(4)}   ${(r.pred * 100).toFixed(1).padStart(7)}%   ${(r.actual * 100).toFixed(1).padStart(6)}%   ${(gap >= 0 ? "+" : "") + (gap * 100).toFixed(1)}pp`
    );
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] MultiPick model scorecard`);

  const preds = await fetchAllPredictions();
  console.log(`Loaded ${preds.length} logged predictions.`);
  if (!preds.length) return;

  const dates = preds.map((p) => String(p.created_at).slice(0, 10));
  console.log(`Date range: ${dates[0]} → ${dates[dates.length - 1]}`);

  // Resolve all samples per sport.
  let all = [];
  for (const sport of ["AFL", "NBA"]) {
    const sportPreds = preds.filter((p) => metricSport(p.metric) === sport);
    if (!sportPreds.length) continue;
    const samples = await buildSamples(sport, sportPreds);
    console.log(`${sport}: ${sportPreds.length} logged · ${samples.length} resolved (${sportPreds.length ? ((samples.length / sportPreds.length) * 100).toFixed(0) : 0}%)`);
    all = all.concat(samples);
  }

  if (!all.length) {
    console.log("\nNo resolved predictions yet — outcomes haven't been scraped. Try again after the games settle.");
    return;
  }

  console.log("\n" + "═".repeat(64));
  console.log("OVERALL — every rated leg (the model's full-domain quality)");
  console.log("═".repeat(64));
  scoreBlock("All rated legs", all);
  reliabilityTable("All rated legs", all);

  const selected = all.filter((s) => s.selected);
  console.log("\n" + "═".repeat(64));
  console.log("SELECTED — only legs put into a multi (what users actually bet)");
  console.log("═".repeat(64));
  scoreBlock("Selected picks", selected);
  reliabilityTable("Selected picks", selected);

  // CLV — uses build vs closing odds directly (no game result needed), so it
  // covers ALL logged predictions, not just the resolved ones.
  console.log("\n" + "═".repeat(64));
  console.log("CLV — did we beat the market's closing price?");
  console.log("═".repeat(64));
  clvReport("All rated legs", preds);
  clvReport("Selected picks", preds.filter((p) => p.selected !== false));

  // Per sport
  for (const sport of ["AFL", "NBA"]) {
    const s = all.filter((x) => x.sport === sport);
    if (s.length >= 20) scoreBlock(`── ${sport} (all rated)`, s);
  }

  // Per market (only ones with enough samples)
  const byMarket = new Map();
  for (const s of all) {
    if (!byMarket.has(s.metric)) byMarket.set(s.metric, []);
    byMarket.get(s.metric).push(s);
  }
  console.log("\n" + "═".repeat(64));
  console.log("BY MARKET (≥30 resolved)");
  console.log("═".repeat(64));
  const markets = [...byMarket.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [market, s] of markets) {
    if (s.length < 30) continue;
    const base = mean(s.map((x) => x.actual));
    const bModel = brier(s, (x) => x.pred);
    const bBase = brier(s, () => base);
    const { ece } = reliability(s, (x) => x.pred);
    console.log(
      `  ${market.padEnd(16)} n=${String(s.length).padStart(4)}  Brier ${bModel.toFixed(4)} (base ${bBase.toFixed(4)})  skill ${((1 - bModel / (bBase || 1)) * 100).toFixed(1).padStart(5)}%  ECE ${(ece * 100).toFixed(1)}%`
    );
  }

  console.log("\nDone. Re-run before/after a model change to see if the change helped.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Backtest failed:", error);
    process.exit(1);
  });
