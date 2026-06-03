// Verify Task #106 fixes: replicates the post-fix math in api/edge.js
// (prior fallback now uses impliedRaw, plus the 0-hits evidence cap).
// The isOver extraction fix is verified separately — that prevents the
// under price from ever ending up as prop.odds in the first place.

function impliedProbFromOdds(odds) {
  const value = Number(odds);
  return value > 1 ? 1 / value : null;
}

function fairProbFromOverUnder(oddsOver, oddsUnder) {
  const pOver = impliedProbFromOdds(oddsOver);
  if (pOver == null) return null;
  const pUnder = impliedProbFromOdds(oddsUnder);
  if (pUnder == null || pUnder <= 0) return pOver;
  return pOver / (pOver + pUnder);
}

function computeHitRate(values, line) {
  if (!values?.length || line == null) return null;
  const hits = values.filter((v) => v >= line).length;
  return { hits, total: values.length, prob: hits / values.length };
}

function weightedHitRate(values, line, decay = 0.85) {
  if (!values?.length || line == null) return null;
  let wHits = 0;
  let wTotal = 0;
  for (let i = 0; i < values.length; i++) {
    const w = Math.pow(decay, i);
    wTotal += w;
    if (values[i] >= line) wHits += w;
  }
  return { hits: wHits, total: wTotal, prob: wHits / wTotal };
}

function runScenario(label, { odds, underOdds, last10, line, matchupFactor = 1, restFactor = 1 }) {
  const last5 = last10.slice(0, 5);

  const impliedRaw = impliedProbFromOdds(odds);
  const implied = fairProbFromOverUnder(odds, underOdds);

  const hr5 = computeHitRate(last5, line);
  const hr10 = computeHitRate(last10, line);

  const PRIOR_WEIGHT = 6;
  // FIX 2: prior fallback now uses impliedRaw before 0.5
  const priorProb =
    implied != null ? implied : impliedRaw != null ? impliedRaw : 0.5;
  const smoothed = (hr) =>
    hr ? (hr.hits + priorProb * PRIOR_WEIGHT) / (hr.total + PRIOR_WEIGHT) : null;
  const blend = (a, b) => (a != null && b != null ? a * 0.4 + b * 0.6 : b != null ? b : a);

  const whr5 = weightedHitRate(last5, line);
  const whr10 = weightedHitRate(last10, line);
  const empBase = blend(smoothed(whr5), smoothed(whr10));

  const scaleVals = (vals) =>
    matchupFactor === 1 ? vals || [] : (vals || []).map((v) => v * matchupFactor);
  const empScaled = blend(
    smoothed(weightedHitRate(scaleVals(last5), line)),
    smoothed(weightedHitRate(scaleVals(last10), line))
  );

  let empirical = empScaled;
  if (
    matchupFactor !== 1 &&
    empBase != null &&
    empScaled != null &&
    Math.abs(empScaled - empBase) < 1e-9
  ) {
    empirical = Math.max(0.02, Math.min(0.98, empBase * matchupFactor));
  }

  if (restFactor !== 1 && empirical != null) {
    empirical = Math.max(0.02, Math.min(0.98, empirical * restFactor));
  }

  // FIX 3: flat 15% evidence ceiling for 0-hits-in-5+-games legs
  if (
    empirical != null &&
    hr10 != null &&
    hr10.hits === 0 &&
    hr10.total >= 5
  ) {
    empirical = Math.min(empirical, 0.15);
  }

  const pct = (empirical * 100).toFixed(1);
  console.log(`  ${label}: priorProb=${priorProb.toFixed(3)}, hr10=${hr10?.hits}/${hr10?.total} → ${pct}%`);
}

console.log("\n========== POST-FIX VERIFICATION ==========\n");

console.log("--- The reported bug: Joel Amartey 6+ goals @ $31, 0/10 hits ---");
runScenario("Canonical (was 1.8%, still 1.8% — never wrong with correct odds)", {
  odds: 31, underOdds: null, last10: [1, 2, 0, 1, 0, 2, 1, 0, 1, 1], line: 5.5,
});

console.log("\n--- The poison path: under price stored as over (was 54.8%) ---");
runScenario("Under-as-over $1.03 (extraction fix prevents this; even if it slips through, cap kicks in)", {
  odds: 1.03, underOdds: null, last10: [1, 2, 0, 1, 0, 2, 1, 0, 1, 1], line: 5.5,
});

console.log("\n--- The prior-collapse path: NaN odds (was 28.2%) ---");
runScenario("NaN odds → was 0.5 prior + 28.2%, now caps via evidence floor", {
  odds: NaN, underOdds: null, last10: [1, 2, 0, 1, 0, 2, 1, 0, 1, 1], line: 5.5,
});

console.log("\n--- Sweep odds with 0/10 hits (was up to 56% at $1.01) ---");
for (const o of [1.01, 1.03, 1.10, 1.30, 1.50, 2.00, 3.00, 10, 31]) {
  runScenario(`$${o} over, 0/10 hits`, {
    odds: o, underOdds: null, last10: Array(10).fill(0), line: 5.5,
  });
}

console.log("\n--- Sanity: a player who actually clears the line should still rate high ---");
runScenario("Player hits 7/10 at $1.50 line — confidence should stay legit", {
  odds: 1.50, underOdds: 2.60,
  last10: [25, 20, 28, 18, 26, 24, 22, 19, 27, 23], line: 19.5,
});

runScenario("Player hits 4/10 at $2.50 line — moderate confidence", {
  odds: 2.50, underOdds: 1.55,
  last10: [25, 12, 28, 8, 26, 14, 22, 9, 27, 13], line: 19.5,
});

console.log("\n--- Sanity: small-sample 0-hits shouldn't be wildly confident either ---");
runScenario("3 games, 0 hits at $2 (was 35% via 0.5 fallback) — now via impliedRaw=0.5 same; cap doesn't trigger (total<5)", {
  odds: NaN, underOdds: null, last10: [0, 0, 0], line: 5.5,
});

runScenario("4 games, 0 hits at $31 — was 2.3%, still 2.3% (cap doesn't trigger; correct priorProb)", {
  odds: 31, underOdds: null, last10: [0, 0, 0, 0], line: 5.5,
});
