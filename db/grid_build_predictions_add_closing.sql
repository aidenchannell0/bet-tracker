-- CLV (Closing Line Value) capture for grid_build_predictions.
--
-- We already store `odds` (the decimal Over price at build time). To measure
-- whether MultiPick's picks beat the market, we also need the CLOSING price for
-- the same player+metric+line — the last price the market offered before the
-- game started (odds disappear once a game begins, so this must be captured
-- beforehand).
--
-- scripts/capture-closing-odds.mjs runs near kickoff (GitHub Action, every ~2h)
-- and writes the latest pre-game Over price into closing_odds, refreshing it on
-- each run until the game starts so the final value ≈ the true closing line.
--
-- CLV is then computed in scripts/backtest.mjs: beating the close (build odds >
-- closing odds) is the fastest leading indicator of real edge — it accrues on
-- every pick immediately, instead of waiting for results to settle.
--
-- Run once in the Supabase SQL editor.
ALTER TABLE grid_build_predictions
  ADD COLUMN IF NOT EXISTS closing_odds numeric,
  ADD COLUMN IF NOT EXISTS closing_captured_at timestamptz;
