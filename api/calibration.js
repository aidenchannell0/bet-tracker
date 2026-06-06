// Calibration scoreboard: how well Grid Build's predicted probabilities match
// reality. Reads logged predictions (grid_build_predictions) and resolves each
// against the player's actual next game in afl_player_games, then buckets by
// predicted probability. No resolver job — outcomes are computed on read.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const METRIC_COLUMNS = [
  "kicks", "marks", "handballs", "disposals", "goals",
  "behinds", "hitouts", "tackles", "clearances", "fantasy_points",
];

// Predicted-probability buckets (lo inclusive, hi exclusive; top catches 1.0)
const BUCKETS = [
  [0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01],
];

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!supabase) return res.status(200).json({ available: false });

  try {
    // The user-facing "picks hit rate" counts SELECTED legs only (the ones built
    // into a multi) — the full rated pool is also logged (for recalibrate's curve
    // domain) but isn't a "pick".
    let { data: preds, error } = await supabase
      .from("grid_build_predictions")
      .select("created_at,name_key,metric,line,predicted_prob")
      .eq("selected", true)
      .order("created_at", { ascending: true })
      .limit(5000);
    // Back-compat: if the `selected` column isn't there yet (migration not run),
    // fall back to all rows so the block still renders.
    if (error && /selected/i.test(error.message || "")) {
      ({ data: preds, error } = await supabase
        .from("grid_build_predictions")
        .select("created_at,name_key,metric,line,predicted_prob")
        .order("created_at", { ascending: true })
        .limit(5000));
    }
    if (error) throw new Error(error.message);

    if (!preds?.length) {
      return res.status(200).json({ available: true, totalPredictions: 0, resolved: 0, buckets: [], overall: null });
    }

    const keys = [...new Set(preds.map((p) => p.name_key).filter(Boolean))];
    const minDate = String(preds[0].created_at).slice(0, 10);

    // Actual results for those players from the earliest prediction date onward
    const cols = `name_key,game_date,${METRIC_COLUMNS.join(",")}`;
    const actuals = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error: e2 } = await supabase
        .from("afl_player_games")
        .select(cols)
        .in("name_key", keys)
        .gte("game_date", minDate)
        .order("game_date", { ascending: true })
        .range(from, from + PAGE - 1);
      if (e2) throw new Error(e2.message);
      if (!data || !data.length) break;
      actuals.push(...data);
      if (data.length < PAGE) break;
    }

    const byKey = new Map();
    for (const r of actuals) {
      if (!byKey.has(r.name_key)) byKey.set(r.name_key, []);
      byKey.get(r.name_key).push(r); // already ascending by game_date
    }

    const buckets = BUCKETS.map(([lo, hi]) => ({ lo, hi, n: 0, predSum: 0, hits: 0 }));
    let resolved = 0, hitsTotal = 0, predSum = 0;

    for (const p of preds) {
      const predDate = String(p.created_at).slice(0, 10);
      const games = byKey.get(p.name_key) || [];
      // The player's first game on/after the prediction = the game the prop was for
      const g = games.find((x) => x.game_date >= predDate && x[p.metric] != null);
      if (!g) continue;
      const hit = Number(g[p.metric]) >= Number(p.line) ? 1 : 0;
      resolved += 1;
      hitsTotal += hit;
      predSum += Number(p.predicted_prob);
      const b = buckets.find((bk) => p.predicted_prob >= bk.lo && p.predicted_prob < bk.hi);
      if (b) { b.n += 1; b.predSum += Number(p.predicted_prob); b.hits += hit; }
    }

    const outBuckets = buckets
      .filter((b) => b.n > 0)
      .map((b) => ({
        label: `${Math.round(b.lo * 100)}–${Math.round(Math.min(b.hi, 1) * 100)}%`,
        n: b.n,
        predicted: Math.round((b.predSum / b.n) * 100),
        actual: Math.round((b.hits / b.n) * 100),
      }));

    const overall = resolved
      ? { n: resolved, predicted: Math.round((predSum / resolved) * 100), actual: Math.round((hitsTotal / resolved) * 100) }
      : null;

    return res.status(200).json({
      available: true,
      totalPredictions: preds.length,
      resolved,
      buckets: outBuckets,
      overall,
    });
  } catch (error) {
    console.error("calibration error:", error);
    return res.status(200).json({ available: false, error: error.message });
  }
}
