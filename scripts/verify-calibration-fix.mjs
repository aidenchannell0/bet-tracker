// Verify the calibration-extrapolation fix against production curves and
// the actual scenarios that produced the 67% / 80% bugs.

// Production curves (queried from model_calibration on 2026-06-02)
const AFL_GLOBAL = [
  { x: 0.63, y: 0.67 },
  { x: 0.72, y: 0.75 },
  { x: 0.80, y: 0.78 },
  { x: 0.89, y: 0.87 },
  { x: 0.97, y: 0.89 },
];
const AFL_DISPOSALS = [
  { x: 0.76, y: 0.80 },
  { x: 0.87, y: 0.95 },
  { x: 0.97, y: 1.00 },
];

function applyOld(curve, x) {
  if (!curve || !curve.length || x == null) return x;
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

function applyNew(curve, x) {
  if (!curve || !curve.length || x == null) return x;
  if (x < curve[0].x) return x;
  if (x > curve[curve.length - 1].x) return x;
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

const cases = [
  // The original bug: Joel Amartey 6+ goals @ $31, 0/10 hits
  // Raw empirical computed honestly = 1.8% (priorProb=0.032 EB-shrunk)
  { label: "Joel Amartey 6+ goals @ $31, 0/10 hits", curve: AFL_GLOBAL, raw: 0.018 },
  // The new screenshot: Toby Murray 13+ disposals @ $2.60, 1/6 hits
  // Raw empirical = ~0.31 (priorProb=0.385, 1 hit weighted)
  { label: "Toby Murray 13+ disposals @ $2.60, 1/6 hits", curve: AFL_DISPOSALS, raw: 0.31 },
  // Borlase 15+ disposals @ $2.55, 2/8 hits, raw ~0.32
  { label: "James Borlase 15+ disposals @ $2.55, 2/8 hits", curve: AFL_DISPOSALS, raw: 0.32 },
  // Inside fitted range — calibration SHOULD apply
  { label: "Mid-confidence leg (raw 0.70) — inside global curve range", curve: AFL_GLOBAL, raw: 0.70 },
  { label: "High-confidence leg (raw 0.85) — inside disposals curve range", curve: AFL_DISPOSALS, raw: 0.85 },
  // Above fitted range — was clamping up, now passes through
  { label: "Very confident leg (raw 0.99) — above curve range", curve: AFL_DISPOSALS, raw: 0.99 },
];

console.log("\n=== Before vs after applyCalibrationCurve fix ===\n");
console.log("input → OLD (buggy)   →   NEW (fixed)   |   scenario");
console.log("-".repeat(85));
for (const { label, curve, raw } of cases) {
  const old = applyOld(curve, raw);
  const fix = applyNew(curve, raw);
  const oldPct = (old * 100).toFixed(1).padStart(5);
  const newPct = (fix * 100).toFixed(1).padStart(5);
  const flag = old !== fix ? " ← FIXED" : "";
  console.log(`${(raw * 100).toFixed(1).padStart(5)}% → ${oldPct}%        →   ${newPct}%        | ${label}${flag}`);
}
