// Shared founder-analytics computation: reads grid_build_multis and resolves each multi's
// legs on read against afl_player_games / nba_player_games. A multi WON iff every leg hit
// its line, LOST if any resolved leg missed, PENDING until all legs have a game to resolve
// against. Used by api/founder-stats.js (the live dashboard) and api/founder-digest.js
// (the weekly email), so the two never drift.

const AFL_METRICS = ["kicks", "marks", "handballs", "disposals", "goals", "behinds", "hitouts", "tackles", "clearances", "fantasy_points"];
// NBA metric key (as stored on legs) -> nba_player_games column
const NBA_METRIC_COL = { points: "pts", rebounds: "reb", assists: "ast", threes: "fg3m", blocks: "blk", steals: "stl" };

function legTarget(metric) {
  if (NBA_METRIC_COL[metric]) return { sport: "nba", col: NBA_METRIC_COL[metric] };
  return { sport: "afl", col: metric }; // AFL: metric key === column name
}

// Combined-odds brackets for the "win rate by odds" filter (lo inclusive, hi exclusive).
const ODDS_BRACKETS = [
  { key: "$1–2", lo: 1, hi: 2 },
  { key: "$2–3", lo: 2, hi: 3 },
  { key: "$3–5", lo: 3, hi: 5 },
  { key: "$5–10", lo: 5, hi: 10 },
  { key: "$10+", lo: 10, hi: Infinity },
];
function oddsBracketKey(odds) {
  const n = Number(odds);
  if (!(n > 0)) return null;
  const b = ODDS_BRACKETS.find((x) => n >= x.lo && n < x.hi);
  return b ? b.key : null;
}

// Monday (UTC) of the week a multi was built — keys the weekly trend.
function weekStartIso(dateStr) {
  const d = new Date(dateStr); if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDay(); const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff); d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function fmtWeekLabel(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
}

function newAgg() { return { total: 0, won: 0, lost: 0, pending: 0, predSum: 0, oddsSum: 0 }; }
function pushAgg(a, status, predictedProb, odds) {
  a.total += 1;
  if (status === "won") a.won += 1;
  else if (status === "lost") a.lost += 1;
  else a.pending += 1;
  if (status !== "pending") {
    if (predictedProb != null) a.predSum += Number(predictedProb);
    if (odds != null) a.oddsSum += Number(odds);
  }
}
function finalizeAgg(a) {
  const resolved = a.won + a.lost;
  return {
    total: a.total,
    won: a.won,
    lost: a.lost,
    pending: a.pending,
    resolved,
    winRate: resolved ? Math.round((a.won / resolved) * 100) : null,       // actual
    predicted: resolved ? Math.round((a.predSum / resolved) * 100) : null, // avg predicted combined prob
    avgOdds: resolved ? Number((a.oddsSum / resolved).toFixed(2)) : null,
  };
}

export async function computeFounderStats(supabase, founderUserId) {
  const { data: multis, error } = await supabase
    .from("grid_build_multis")
    .select("created_at,user_id,sport,leg_count,combined_odds,predicted_prob,profile,target_odds,legs")
    .order("created_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);

  if (!multis?.length) {
    return { available: true, overall: finalizeAgg(newAgg()), you: finalizeAgg(newAgg()), others: finalizeAgg(newAgg()), bySport: {}, distinctUsers: 0, recent: [], generatedAt: new Date().toISOString() };
  }

  // Collect player keys per sport + earliest date, then batch the game logs.
  const aflKeys = new Set(), nbaKeys = new Set();
  let minDate = "9999-12-31";
  for (const m of multis) {
    const d = String(m.created_at).slice(0, 10);
    if (d < minDate) minDate = d;
    for (const leg of m.legs || []) {
      if (!leg?.name_key || !leg?.metric) continue;
      (legTarget(leg.metric).sport === "nba" ? nbaKeys : aflKeys).add(leg.name_key);
    }
  }

  async function fetchGames(table, cols, keys) {
    const byKey = new Map();
    if (!keys.size) return byKey;
    const keyArr = [...keys];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error: e2 } = await supabase
        .from(table)
        .select(cols)
        .in("name_key", keyArr)
        .gte("game_date", minDate)
        .order("game_date", { ascending: true })
        .range(from, from + PAGE - 1);
      if (e2) throw new Error(e2.message);
      if (!data?.length) break;
      for (const r of data) {
        if (!byKey.has(r.name_key)) byKey.set(r.name_key, []);
        byKey.get(r.name_key).push(r);
      }
      if (data.length < PAGE) break;
    }
    return byKey;
  }

  const byAfl = await fetchGames("afl_player_games", `name_key,game_date,${AFL_METRICS.join(",")}`, aflKeys);
  const byNba = await fetchGames("nba_player_games", "name_key,game_date,pts,reb,ast,fg3m,stl,blk", nbaKeys);

  function resolveLeg(leg, afterDate) {
    const { sport, col } = legTarget(leg.metric);
    const games = (sport === "nba" ? byNba : byAfl).get(leg.name_key) || [];
    const g = games.find((x) => x.game_date >= afterDate && x[col] != null);
    if (!g) return null; // unresolved
    return Number(g[col]) >= Number(leg.line) ? 1 : 0;
  }

  function resolveMulti(m) {
    const afterDate = String(m.created_at).slice(0, 10);
    let anyMiss = false, anyUnresolved = false;
    for (const leg of m.legs || []) {
      if (!leg?.name_key || !leg?.metric || leg.line == null) { anyUnresolved = true; continue; }
      const r = resolveLeg(leg, afterDate);
      if (r === null) anyUnresolved = true;
      else if (r === 0) anyMiss = true;
    }
    if (anyMiss) return "lost";          // one miss sinks the multi, even with legs pending
    if (anyUnresolved) return "pending";
    return "won";
  }

  const overall = newAgg(), you = newAgg(), others = newAgg();
  const bySportAgg = {};
  const byOddsAgg = {};
  const users = new Set();
  const recent = [];
  const weeklyAgg = new Map();

  for (const m of multis) {
    const status = resolveMulti(m);
    pushAgg(overall, status, m.predicted_prob, m.combined_odds);
    const mine = m.user_id && m.user_id === founderUserId;
    pushAgg(mine ? you : others, status, m.predicted_prob, m.combined_odds);
    const sp = (m.sport || "other").toLowerCase();
    (bySportAgg[sp] ||= newAgg());
    pushAgg(bySportAgg[sp], status, m.predicted_prob, m.combined_odds);
    const ob = oddsBracketKey(m.combined_odds);
    if (ob) { (byOddsAgg[ob] ||= newAgg()); pushAgg(byOddsAgg[ob], status, m.predicted_prob, m.combined_odds); }
    if (m.user_id) users.add(m.user_id);
    const wk = weekStartIso(m.created_at);
    if (wk) {
      const w = weeklyAgg.get(wk) || { wk, mWon: 0, mLost: 0, legCleared: 0, legTotal: 0 };
      if (status === "won") w.mWon++; else if (status === "lost") w.mLost++;
      const afterDate = String(m.created_at).slice(0, 10);
      for (const leg of m.legs || []) {
        if (!leg?.name_key || !leg?.metric || leg.line == null) continue;
        const r = resolveLeg(leg, afterDate);
        if (r === null) continue;
        w.legTotal++; if (r === 1) w.legCleared++;
      }
      weeklyAgg.set(wk, w);
    }
    recent.push({
      created_at: m.created_at,
      sport: m.sport || null,
      legCount: m.leg_count,
      odds: m.combined_odds,
      predicted: m.predicted_prob != null ? Math.round(Number(m.predicted_prob) * 100) : null,
      profile: m.profile || null,
      status,
      isYou: !!mine,
      legs: (m.legs || []).map((l) => ({ name: l.player_name, metric: l.metric, line: l.line })),
    });
  }

  const bySport = {};
  for (const [k, v] of Object.entries(bySportAgg)) bySport[k] = finalizeAgg(v);
  const byOdds = ODDS_BRACKETS.map((b) => ({
    key: b.key,
    lo: b.lo,
    hi: b.hi === Infinity ? null : b.hi,
    ...finalizeAgg(byOddsAgg[b.key] || newAgg()),
  }));

  return {
    available: true,
    overall: finalizeAgg(overall),
    you: finalizeAgg(you),
    others: finalizeAgg(others),
    bySport,
    byOdds,
    distinctUsers: users.size,
    recent: recent.reverse().slice(0, 40),
    weekly: [...weeklyAgg.values()].sort((a, b) => (a.wk < b.wk ? -1 : 1)).slice(-10).map((w) => ({
      label: fmtWeekLabel(w.wk),
      multiTotal: w.mWon + w.mLost,
      multiWon: w.mWon,
      multiLost: w.mLost,
      multiRate: (w.mWon + w.mLost) ? Math.round((100 * w.mWon) / (w.mWon + w.mLost)) : null,
      legCleared: w.legCleared,
      legTotal: w.legTotal,
      legRate: w.legTotal ? Math.round((100 * w.legCleared) / w.legTotal) : null,
    })),
    generatedAt: new Date().toISOString(),
  };
}
