// Weekly founder email digest. Triggered by a Vercel cron (see vercel.json). Computes the
// same win/loss stats as the dashboard (shared lib) and emails a summary to the founder via
// Resend. Gated so only Vercel cron (or a caller holding CRON_SECRET) can run it.
//
// Required env to actually send: RESEND_API_KEY. Optional: DIGEST_FROM (a verified Resend
// sender, e.g. "Pickd <reports@pickd.tech>"; defaults to Resend's test sender, which only
// delivers to your own Resend account email), FOUNDER_EMAIL, CRON_SECRET.

import { createClient } from "@supabase/supabase-js";
import { computeFounderStats } from "../lib/founderStats.js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;

const FOUNDER_EMAIL = (process.env.FOUNDER_EMAIL || "aidenchannell0@gmail.com").toLowerCase();
const DIGEST_FROM = process.env.DIGEST_FROM || "Pickd <onboarding@resend.dev>";

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

function buildHtml(s) {
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

export default async function handler(req, res) {
  // ── Gate: Vercel cron, or a caller holding CRON_SECRET ──
  const cronSecret = process.env.CRON_SECRET;
  const authed = cronSecret ? req.headers.authorization === `Bearer ${cronSecret}` : !!req.headers["x-vercel-cron"];
  if (!authed) return res.status(401).json({ error: "Unauthorized" });
  if (!supabase) return res.status(200).json({ sent: false, reason: "not_configured" });

  try {
    const founderUserId = await findFounderId(FOUNDER_EMAIL);
    const stats = await computeFounderStats(supabase, founderUserId);
    if (!stats.available || stats.overall.total === 0) {
      return res.status(200).json({ sent: false, reason: "no_data" });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      // No email provider wired yet — succeed quietly so the cron doesn't error.
      return res.status(200).json({ sent: false, reason: "no_email_key", overall: stats.overall });
    }

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: DIGEST_FROM,
        to: [FOUNDER_EMAIL],
        subject: `Pickd · MultiPick ${pct(stats.overall.winRate)} win rate · ${stats.overall.total} multis`,
        html: buildHtml(stats),
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
