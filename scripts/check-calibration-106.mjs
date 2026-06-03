// Quick check: is there a fitted calibration curve in production?
// If yes, what does it look like — and could it be inflating raw empiricals?

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

// Load .env
const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const supabase = createClient(
  env.SUPABASE_URL || env.VITE_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY
);

// 1) Is the model_calibration table populated?
const { data: curves, error: cErr } = await supabase
  .from("model_calibration")
  .select("sport,market,fit_date,n_samples,rmse,curve_points")
  .order("fit_date", { ascending: false });

if (cErr) {
  console.log("model_calibration query error:", cErr.message);
} else {
  console.log(`\n=== model_calibration rows: ${curves?.length ?? 0} ===`);
  for (const row of curves || []) {
    console.log(`  ${row.sport} / ${row.market || "(global)"} — n=${row.n_samples}, rmse=${row.rmse}, fit=${row.fit_date}`);
    if (row.curve_points && row.curve_points.length) {
      console.log(`    curve: ${row.curve_points.map((p) => `(${p.x?.toFixed?.(2)},${p.y?.toFixed?.(2)})`).join(" → ")}`);
    }
  }
}

// 2) Check the prediction log to see how many resolved predictions exist
const { data: predRows, count } = await supabase
  .from("grid_build_predictions")
  .select("*", { count: "exact", head: true });
console.log(`\n=== grid_build_predictions: ${count} total rows ===`);

// 3) Look up Toby Murray's actual recent disposals to verify the 1/6 cleared
const { data: murray } = await supabase
  .from("afl_player_games")
  .select("game_date,disposals")
  .eq("name_key", "t_murray")
  .order("game_date", { ascending: false })
  .limit(10);
console.log(`\n=== Toby Murray ('t_murray') recent disposals ===`);
for (const row of murray || []) {
  const cleared = row.disposals >= 13 ? "✓" : "✗";
  console.log(`  ${row.game_date}: ${row.disposals} disposals ${cleared} (13+ line)`);
}

// 4) Same for James Borlase
const { data: borlase } = await supabase
  .from("afl_player_games")
  .select("game_date,disposals")
  .eq("name_key", "j_borlase")
  .order("game_date", { ascending: false })
  .limit(10);
console.log(`\n=== James Borlase ('j_borlase') recent disposals ===`);
for (const row of borlase || []) {
  const cleared = row.disposals >= 15 ? "✓" : "✗";
  console.log(`  ${row.game_date}: ${row.disposals} disposals ${cleared} (15+ line)`);
}
