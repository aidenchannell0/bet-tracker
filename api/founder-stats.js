// PRIVATE founder analytics endpoint: real per-multi win/loss across all users, gated to
// the founder's account only. Auth (verify JWT email) lives here; the heavy lifting
// (resolve + aggregate) is shared with the weekly email digest in lib/founderStats.js.

import { createClient } from "@supabase/supabase-js";
import { computeFounderStats } from "../lib/founderStats.js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;

// Only this account may read the founder view. Configurable via env; defaults to the founder.
const FOUNDER_EMAIL = (process.env.FOUNDER_EMAIL || "aidenchannell0@gmail.com").toLowerCase();

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!supabase) return res.status(200).json({ available: false, reason: "not_configured" });

  // ── Gate: caller must be the founder ──
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
