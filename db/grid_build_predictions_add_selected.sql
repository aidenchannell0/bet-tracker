-- Add a `selected` flag to grid_build_predictions.
-- We now log EVERY rated leg (the full enriched pool) on each build, not just the
-- legs that made it into the multi — this widens the calibration/ML dataset to
-- cover the model's low-confidence ratings (the legs it correctly rejects), which
-- the recalibration curve needs to span the full probability domain.
--
-- `selected = true`  → the leg was put into a built multi (a real "pick").
-- `selected = false` → the leg was rated but not chosen.
--
-- The user-facing calibration block ("MultiPick's last N picks hit X%") filters to
-- selected = true so the headline still reflects actual picks. recalibrate.mjs uses
-- all rows. Existing rows were all selected legs, so the default of true is correct.
--
-- Run once in the Supabase SQL editor.
ALTER TABLE grid_build_predictions
  ADD COLUMN IF NOT EXISTS selected boolean NOT NULL DEFAULT true;

-- Helps the calibration read filter on selected.
CREATE INDEX IF NOT EXISTS grid_build_predictions_selected_idx
  ON grid_build_predictions (selected);
