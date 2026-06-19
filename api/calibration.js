// Calibration scoreboard: how well Grid Build's predicted probabilities match
// reality. Reads logged predictions (grid_build_predictions) and resolves each
// against the player's actual next game in afl_player_games, then buckets by
// predicted probability. No resolver job — outcomes are computed on read.

import { createClient } from "@supabase/supabase-js";
import { computeFounderStats } from "../lib/founderStats.js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Founder-only analytics modes are folded into this endpoint (not separate files) to stay
// under Vercel's 12-serverless-function Hobby limit:
//   /api/calibration                 → public picks-hit-rate (default, below)
//   /api/calibration?view=founder    → private per-multi win/loss (JWT email gate)
//   /api/calibration?mode=digest     → weekly email digest (cron gate)
const FOUNDER_EMAIL = (process.env.FOUNDER_EMAIL || "aidenchannell0@gmail.com").toLowerCase();
const DIGEST_FROM = process.env.DIGEST_FROM || "Pickd <onboarding@resend.dev>";

const METRIC_COLUMNS = [
  "kicks", "marks", "handballs", "disposals", "goals",
  "behinds", "hitouts", "tackles", "clearances", "fantasy_points",
];

// Predicted-probability buckets (lo inclusive, hi exclusive; top catches 1.0)
const BUCKETS = [
  [0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01],
];

export default async function handler(req, res) {
  // Founder-only modes (gated inside each handler).
  if (req.query?.mode === "digest") return handleFounderDigest(req, res);
  if (req.query?.view === "founder") return handleFounderStats(req, res);

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

// ── Founder analytics (folded in to respect the 12-function Hobby limit) ──────────

// GET /api/calibration?view=founder  — private per-multi win/loss across all users.
async function handleFounderStats(req, res) {
  if (!supabase) return res.status(200).json({ available: false, reason: "not_configured" });
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "Sign in required" });
  let founderUserId = null;
  try {
    const { data: userData } = await supabase.auth.getUser(token);
    const user = userData?.user;
    if (!user || (user.email || "").toLowerCase() !== FOUNDER_EMAIL) {
      return res.status(403).json({ error: "Forbidden" });
    }
    founderUserId = user.id;
  } catch {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const stats = await computeFounderStats(supabase, founderUserId);
    return res.status(200).json(stats);
  } catch (e) {
    console.error("founder-stats error:", e);
    return res.status(200).json({ available: false, error: e.message });
  }
}

async function findFounderId(email) {
  try {
    for (let page = 1; page <= 25; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data?.users?.length) break;
      const u = data.users.find((x) => (x.email || "").toLowerCase() === email);
      if (u) return u.id;
      if (data.users.length < 200) break;
    }
  } catch { /* ignore */ }
  return null;
}

const pct = (v) => (v == null ? "—" : `${v}%`);

function buildDigestHtml(s) {
  const o = s.overall;
  const gap = o.predicted != null && o.winRate != null ? o.predicted - o.winRate : null;
  const cal = gap == null ? "" : Math.abs(gap) <= 4 ? "Well calibrated" : gap > 0 ? `Overconfident (+${gap}%)` : `Underconfident (${gap}%)`;
  const sportRows = Object.entries(s.bySport)
    .map(([sp, v]) => `<tr><td style="padding:4px 0;text-transform:uppercase;font-weight:600">${sp}</td><td style="padding:4px 0;text-align:right">${v.total} built · <b>${pct(v.winRate)}</b> · ${v.won}–${v.lost} (${v.pending} pending)</td></tr>`)
    .join("");
  const recentRows = (s.recent || []).slice(0, 10)
    .map((m) => `<tr><td style="padding:4px 0;color:#6f6f79;width:70px">${new Date(m.created_at).toLocaleDateString()}</td><td style="padding:4px 0">${(m.legs || []).map((l) => l.name).join(", ") || m.legCount + " legs"}${m.isYou ? " · you" : ""}</td><td style="padding:4px 0;text-align:right;font-weight:600;color:${m.status === "won" ? "#15803d" : m.status === "lost" ? "#be123c" : "#a16207"}">${m.status}</td></tr>`)
    .join("");
  return `<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#11203b">
    <p style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#6f6f79;margin:0 0 6px">Pickd · Founder · Weekly</p>
    <h1 style="font-size:26px;margin:0 0 4px">MultiPick performance</h1>
    <p style="font-size:13px;color:#6f6f79;margin:0 0 20px">Across every multi built — yours and all users'.</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">
      <div style="border:1px solid #e2e2e2;border-radius:12px;padding:14px 18px"><div style="font-size:11px;color:#6f6f79">Win rate</div><div style="font-size:28px;font-weight:700;color:#15803d">${pct(o.winRate)}</div><div style="font-size:11px;color:#6f6f79">${o.won} won · ${o.lost} lost</div></div>
      <div style="border:1px solid #e2e2e2;border-radius:12px;padding:14px 18px"><div style="font-size:11px;color:#6f6f79">Multis built</div><div style="font-size:28px;font-weight:700">${o.total}</div><div style="font-size:11px;color:#6f6f79">${s.distinctUsers} users · ${o.pending} pending</div></div>
      <div style="border:1px solid #e2e2e2;border-radius:12px;padding:14px 18px"><div style="font-size:11px;color:#6f6f79">Predicted vs actual</div><div style="font-size:28px;font-weight:700">${pct(o.predicted)} → ${pct(o.winRate)}</div><div style="font-size:11px;color:#6f6f79">${cal}</div></div>
    </div>
    <p style="font-size:13px;margin:0 0 14px"><b>You:</b> ${s.you.total} built · ${pct(s.you.winRate)} win &nbsp;·&nbsp; <b>Others:</b> ${s.others.total} built · ${pct(s.others.winRate)} win</p>
    ${sportRows ? `<h3 style="font-size:13px;margin:18px 0 4px">By sport</h3><table style="width:100%;font-size:13px;border-collapse:collapse">${sportRows}</table>` : ""}
    ${recentRows ? `<h3 style="font-size:13px;margin:18px 0 4px">Recent</h3><table style="width:100%;font-size:13px;border-collapse:collapse">${recentRows}</table>` : ""}
    <p style="font-size:11px;color:#9a9aa4;margin-top:22px">Resolved live from game logs · ${new Date(s.generatedAt).toLocaleString()}. Private to you.</p>
  </div>`;
}

// /api/calibration?mode=digest  — weekly email digest (Vercel cron / CRON_SECRET gated).
async function handleFounderDigest(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authed = cronSecret ? req.headers.authorization === `Bearer ${cronSecret}` : !!req.headers["x-vercel-cron"];
  if (!authed) return res.status(401).json({ error: "Unauthorized" });
  if (!supabase) return res.status(200).json({ sent: false, reason: "not_configured" });
  try {
    const founderUserId = await findFounderId(FOUNDER_EMAIL);
    const stats = await computeFounderStats(supabase, founderUserId);
    if (!stats.available || stats.overall.total === 0) return res.status(200).json({ sent: false, reason: "no_data" });
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return res.status(200).json({ sent: false, reason: "no_email_key", overall: stats.overall });
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: DIGEST_FROM,
        to: [FOUNDER_EMAIL],
        subject: `Pickd · MultiPick ${pct(stats.overall.winRate)} win rate · ${stats.overall.total} multis`,
        html: buildDigestHtml(stats),
      }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(200).json({ sent: false, reason: "send_failed", detail: out });
    return res.status(200).json({ sent: true, id: out?.id || null });
  } catch (e) {
    console.error("founder-digest error:", e);
    return res.status(200).json({ sent: false, error: e.message });
  }
}
