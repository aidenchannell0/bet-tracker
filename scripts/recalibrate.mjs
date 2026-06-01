// Weekly self-improvement job: refits MultiPick's calibration curves from
// historical predictions vs actual outcomes. The fitted curves are stored in
// model_calibration; api/edge.js loads the latest per-sport curve at request
// time and applies it to every new prediction. As more data accumulates,
// MultiPick's confidence numbers self-correct toward reality.
//
// Algorithm: Pool-Adjacent-Violators (PAV) isotonic regression.
//   1. Bin all predictions by their predicted probability into 5pp bands.
//   2. For each bin, compute the actual hit rate (hits / total).
//   3. Apply PAV to enforce monotonicity (predicted up = actual up).
//   4. Store the (raw_x, calibrated_y) curve points as JSON.
//   5. At prediction time, linear-interpolate between adjacent curve points.
//
// Env: SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
// Run: node scripts/recalibrate.mjs

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Sport-specific metric mappings. AFL metric names match the column names in
// afl_player_games; NBA metric names can be longhand or shorthand and map to
// the column names in nba_player_games.
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

// Pool-Adjacent-Violators isotonic regression — fits a non-decreasing step
// function through weighted (x, y) points. Greedy O(n²) but fine at our
// scale (a few dozen bins per sport).
function isotonicFit(points) {
  if (!points.length) return [];
  const blocks = points.map((p) => ({ x: p.x, y: p.y, w: p.w || 1 }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < blocks.length - 1; i += 1) {
      if (blocks[i].y > blocks[i + 1].y) {
        // Violation — pool the two blocks together using weighted average
        const a = blocks[i];
        const b = blocks[i + 1];
        const totalW = a.w + b.w;
        blocks.splice(i, 2, {
          x: (a.x * a.w + b.x * b.w) / totalW,
          y: (a.y * a.w + b.y * b.w) / totalW,
          w: totalW,
        });
        changed = true;
        break;
      }
    }
  }
  return blocks.map(({ x, y }) => ({ x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) }));
}

// Apply the curve at a given x via linear interpolation between adjacent points.
// Clamps to the endpoints when x falls outside the curve's range.
function applyCurve(curve, x) {
  if (!curve || !curve.length) return x;
  if (x <= curve[0].x) return curve[0].y;
  if (x >= curve[curve.length - 1].x) return curve[curve.length - 1].y;
  for (let i = 0; i < curve.length - 1; i += 1) {
    if (x >= curve[i].x && x <= curve[i + 1].x) {
      const span = curve[i + 1].x - curve[i].x;
      if (span <= 0) return curve[i].y;
      const t = (x - curve[i].x) / span;
      return curve[i].y + t * (curve[i + 1].y - curve[i].y);
    }
  }
  return x;
}

async function fetchAllPredictions() {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("grid_build_predictions")
      .select("created_at,name_key,metric,line,predicted_prob")
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

async function fitCurveForSport(sport, allPreds, minSamples = 30) {
  console.log(`\n— Fitting ${sport} —`);

  // Filter predictions to this sport
  const preds = allPreds.filter((p) => metricSport(p.metric) === sport);
  if (!preds.length) {
    console.log(`  No ${sport} predictions logged yet.`);
    return null;
  }
  console.log(`  ${preds.length} ${sport} predictions on record.`);

  const tableName = sport === "AFL" ? "afl_player_games" : "nba_player_games";
  const sportCols = sport === "AFL"
    ? [...AFL_METRICS]
    : ["pts", "reb", "ast", "fg3m", "stl", "blk"];
  const cols = `name_key,game_date,${sportCols.join(",")}`;
  const keys = [...new Set(preds.map((p) => p.name_key))];
  const minDate = String(preds[0].created_at).slice(0, 10);

  const actuals = await fetchActuals(tableName, cols, keys, minDate);
  console.log(`  ${actuals.length} actual game rows fetched for ${keys.length} unique players.`);

  // Group actuals by name_key for fast lookup
  const byKey = new Map();
  for (const r of actuals) {
    if (!byKey.has(r.name_key)) byKey.set(r.name_key, []);
    byKey.get(r.name_key).push(r);
  }

  // Resolve each prediction against the player's first game on/after the
  // prediction date. Same logic as api/calibration.js so the two stay aligned.
  const samples = [];
  for (const p of preds) {
    const col = metricColumn(sport, p.metric);
    if (!col) continue;
    const predDate = String(p.created_at).slice(0, 10);
    const games = byKey.get(p.name_key) || [];
    const g = games.find((x) => x.game_date >= predDate && x[col] != null);
    if (!g) continue;
    const hit = Number(g[col]) >= Number(p.line) ? 1 : 0;
    samples.push({ x: Number(p.predicted_prob), y: hit });
  }

  if (samples.length < minSamples) {
    console.log(`  Only ${samples.length} resolved samples — need at least ${minSamples}. Skipping fit.`);
    return null;
  }

  // Bin into 5pp bands
  const BIN_SIZE = 0.05;
  const bins = new Map();
  for (const s of samples) {
    const idx = Math.floor(s.x / BIN_SIZE);
    if (!bins.has(idx)) bins.set(idx, { hits: 0, total: 0 });
    const b = bins.get(idx);
    b.hits += s.y;
    b.total += 1;
  }
  const binPoints = [...bins.entries()]
    .map(([idx, b]) => ({
      x: idx * BIN_SIZE + BIN_SIZE / 2,
      y: b.hits / b.total,
      w: b.total,
    }))
    .sort((a, b) => a.x - b.x);

  // Apply isotonic
  const curve = isotonicFit(binPoints);

  // Compute calibration RMSE on the raw samples vs the calibrated prediction
  let sumSq = 0;
  for (const s of samples) {
    const cal = applyCurve(curve, s.x);
    sumSq += (s.y - cal) ** 2;
  }
  const rmse = Math.sqrt(sumSq / samples.length);

  console.log(`  ${samples.length} resolved · ${binPoints.length} bins · curve has ${curve.length} points · RMSE ${(rmse * 100).toFixed(2)}%`);

  return { sport, samples: samples.length, curve, rmse };
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting model recalibration`);

  const allPreds = await fetchAllPredictions();
  console.log(`Loaded ${allPreds.length} historical predictions.`);

  if (!allPreds.length) {
    console.log("No predictions yet — nothing to calibrate.");
    return;
  }

  const results = [];
  for (const sport of ["AFL", "NBA"]) {
    try {
      const fit = await fitCurveForSport(sport, allPreds);
      if (fit) results.push(fit);
    } catch (error) {
      console.error(`Error fitting ${sport}:`, error.message);
    }
  }

  if (!results.length) {
    console.log("\nNo curves fitted — not enough data yet. Try again next week.");
    return;
  }

  // Persist fitted curves
  for (const r of results) {
    const { error } = await supabase
      .from("model_calibration")
      .insert({
        sport: r.sport,
        market: null,
        n_samples: r.samples,
        curve_points: r.curve,
        rmse: r.rmse,
      });
    if (error) {
      console.error(`Failed to store ${r.sport} curve:`, error.message);
    } else {
      console.log(`\nStored ${r.sport} curve: ${r.curve.length} points, ${r.samples} samples, RMSE ${(r.rmse * 100).toFixed(2)}%`);
    }
  }

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Recalibration failed:", error);
    process.exit(1);
  });
