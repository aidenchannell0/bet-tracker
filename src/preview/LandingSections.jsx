// Pickd landing — shared HTML sections (NO Three.js). Imported by both the desktop
// 3D landing (Landing3D.jsx, with the orbiting star-dust canvas behind it) and the
// light mobile landing (Landing2D.jsx, static backdrop). Keeping the markup here means
// phones never download Three.js just to read the page.
import { useRef, useState, useEffect } from "react";

export const LIME = "#d4f23a";
export const BG = "#0a0a0b";

// CTA handlers, assigned by whichever landing wrapper renders this content. The buttons
// below call these at click time, so the wrapper just sets the real handlers each render.
export const cta = { startFree: () => {}, login: () => {}, explore: () => {} };

/* ─────────────────────────── data cards ─────────────────────────── */
const card = { position: "relative", borderRadius: 22, border: "1px solid #23242b", background: "rgba(11,12,16,0.72)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", padding: "26px 28px", boxShadow: "0 30px 80px rgba(0,0,0,0.45)" };
const labelStyle = { fontSize: 10.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "#6f6f79", fontWeight: 600 };
const mono = { fontFamily: "ui-monospace, 'JetBrains Mono', monospace" };

function ReceiptsCard() {
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 22 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>MultiPick<span style={{ color: LIME }}>.</span> hit rate</div>
        <div style={labelStyle}>Last 328 picks</div>
      </div>
      <div style={labelStyle}>Actual hit rate</div>
      <div style={{ ...mono, fontSize: 84, fontWeight: 700, color: "#5bd06a", lineHeight: 1, margin: "6px 0 8px" }}>82%</div>
      <div style={{ fontSize: 14, color: "#9a9aa4" }}><b style={{ color: "#e9e9ec" }}>269</b> of <b style={{ color: "#e9e9ec" }}>328</b> legs hit their line</div>
      <div style={{ display: "flex", gap: 40, marginTop: 26, paddingTop: 22, borderTop: "1px solid #1d1d25" }}>
        <div><div style={labelStyle}>We predicted</div><div style={{ ...mono, fontSize: 30, fontWeight: 700, marginTop: 4 }}>89%</div><div style={{ fontSize: 11.5, color: "#6f6f79", marginTop: 2 }}>Average confidence</div></div>
        <div><div style={labelStyle}>Gap</div><div style={{ ...mono, fontSize: 30, fontWeight: 700, marginTop: 4 }}>±7%</div><div style={{ fontSize: 11.5, color: "#6f6f79", marginTop: 2 }}>Prediction vs reality</div></div>
      </div>
    </div>
  );
}
function TrackerCard() {
  const form = "WWLWWWWLWWLWWWLWWWWL";
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 20 }}><div style={labelStyle}>Dashboard · April 2026</div><div style={{ ...labelStyle, color: LIME }}>● Live</div></div>
      <div style={{ display: "flex", gap: 26, flexWrap: "wrap", marginBottom: 24 }}>
        {[["Profit / loss", "+$246.50", "#5bd06a"], ["Win rate", "58.3%", "#e9e9ec"], ["Return on stake", "+12.8%", "#5bd06a"], ["In flight", "$84.00", "#e9e9ec"]].map(([l, v, c]) => (
          <div key={l}><div style={labelStyle}>{l}</div><div style={{ ...mono, fontSize: 24, fontWeight: 700, color: c, marginTop: 4 }}>{v}</div></div>
        ))}
      </div>
      <div style={{ ...labelStyle, marginBottom: 8 }}>Cumulative P/L · 12 weeks</div>
      <svg viewBox="0 0 320 70" style={{ width: "100%", height: 64, display: "block", marginBottom: 22 }} preserveAspectRatio="none">
        <polyline points="0,60 30,52 60,55 90,42 120,46 150,34 180,30 210,22 240,26 270,14 300,8 320,4" fill="none" stroke="#5bd06a" strokeWidth="2" />
        <polyline points="0,60 30,52 60,55 90,42 120,46 150,34 180,30 210,22 240,26 270,14 300,8 320,4 320,70 0,70" fill="rgba(91,208,106,0.12)" stroke="none" />
      </svg>
      <div style={{ ...labelStyle, marginBottom: 8 }}>Recent form · last 20</div>
      <div style={{ display: "flex", gap: 4 }}>{form.split("").map((r, i) => <div key={i} style={{ width: 13, height: 16, borderRadius: 3, background: r === "W" ? "#3f9d4e" : "#a04646" }} />)}</div>
    </div>
  );
}
function MultiPickCard() {
  const legs = [["M. Bontempelli", "25+ disposals", "9/10", "79%", "+7% value", "$1.38"], ["C. Curnow", "1+ goals", "8/10", "84%", "+3% value", "$1.30"], ["T. Stengle", "20+ disposals", "8/10", "76%", "−2% edge", "$1.18"]];
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div><div style={labelStyle}>MultiPick output · example</div><div style={{ fontSize: 21, fontWeight: 700, marginTop: 6 }}>3-leg AFL multi</div><div style={{ fontSize: 12.5, color: "#9a9aa4", marginTop: 2 }}>Geelong vs Carlton · 7:50pm</div></div>
        <div style={{ textAlign: "right", border: "1px solid #2a2a31", borderRadius: 12, padding: "8px 12px" }}><div style={{ ...labelStyle, fontSize: 9.5 }}>Combined</div><div style={{ ...mono, fontSize: 22, fontWeight: 700 }}>$2.12</div><div style={{ fontSize: 10.5, color: "#6f6f79" }}>~48% chance</div></div>
      </div>
      <div style={{ display: "inline-block", fontSize: 11.5, color: "#5bd06a", background: "rgba(91,208,106,0.1)", border: "1px solid rgba(91,208,106,0.25)", borderRadius: 8, padding: "4px 10px", marginBottom: 8 }}>● Value vs market +4% · 2 of 3 legs positive edge</div>
      {legs.map(([n, l, hit, conf, val, odds], i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 0", borderTop: i ? "1px solid #1a1a20" : "none" }}>
          <div><div style={{ fontSize: 14.5, fontWeight: 600 }}>{n} <span style={{ color: "#9a9aa4", fontWeight: 400 }}>— {l}</span></div><div style={{ fontSize: 11.5, color: "#6f6f79", marginTop: 2 }}>Hit {hit} · Conf {conf} · <span style={{ color: val[0] === "−" ? "#9a9aa4" : "#5bd06a" }}>{val}</span></div></div>
          <div style={{ ...mono, fontSize: 16, fontWeight: 600 }}>{odds}</div>
        </div>
      ))}
    </div>
  );
}
function QuickAddCard() {
  return (
    <div style={card}>
      <div style={{ ...labelStyle, marginBottom: 14 }}>Quick add · AI vision</div>
      <div style={{ fontSize: 16, lineHeight: 1.5, marginBottom: 18 }}>Drop, paste, or upload a betslip screenshot — <span style={{ color: "#9a9aa4" }}>we'll read the stake, odds and legs and fill the form for you.</span></div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "#6f6f79", marginBottom: 20 }}><span style={{ ...mono, border: "1px solid #2a2a31", borderRadius: 6, padding: "3px 8px" }}>⌘V</span> to paste · or click anywhere to upload</div>
      <div style={{ display: "flex", gap: 34, paddingTop: 18, borderTop: "1px solid #1d1d25" }}>
        {[["Stake", "$25.00"], ["Odds", "$4.20"], ["Legs", "3"]].map(([l, v]) => <div key={l}><div style={labelStyle}>{l}</div><div style={{ ...mono, fontSize: 24, fontWeight: 700, marginTop: 4 }}>{v}</div></div>)}
      </div>
    </div>
  );
}
function PricingCard({ narrow }) {
  return (
    <div style={{ display: "flex", flexDirection: narrow ? "column" : "row", gap: 14 }}>
      <div style={{ ...card, flex: 1, padding: "22px 22px" }}>
        <div style={labelStyle}>Free</div>
        <div style={{ ...mono, fontSize: 40, fontWeight: 700, margin: "4px 0 14px" }}>$0<span style={{ fontSize: 14, color: "#6f6f79", fontWeight: 400 }}> forever</span></div>
        {["Unlimited bet tracking", "Full analytics", "Betslip OCR", "3 MultiPick / week"].map((t) => <div key={t} style={{ fontSize: 13, color: "#9a9aa4", padding: "4px 0" }}>· {t}</div>)}
      </div>
      <div style={{ ...card, flex: 1, padding: "22px 22px", border: `1px solid ${LIME}`, boxShadow: `0 30px 80px rgba(212,242,58,0.12)` }}>
        <div style={{ ...labelStyle, color: LIME }}>Pickd Pro · founding</div>
        <div style={{ ...mono, fontSize: 40, fontWeight: 700, margin: "4px 0 4px" }}>$4.99<span style={{ fontSize: 14, color: "#6f6f79", fontWeight: 400 }}> /wk</span></div>
        <div style={{ fontSize: 11, color: LIME, marginBottom: 12 }}>🔒 13 spots left · locked in forever</div>
        {["Everything in Free", "Unlimited MultiPick", "Priority support", "Early access"].map((t) => <div key={t} style={{ fontSize: 13, color: "#c2c2c9", padding: "4px 0" }}>· {t}</div>)}
        <button onClick={() => cta.startFree()} style={{ marginTop: 12, width: "100%", background: LIME, color: "#0a0a0b", fontWeight: 700, fontSize: 14, border: "none", borderRadius: 12, padding: "12px", cursor: "pointer" }}>Upgrade to Pro →</button>
      </div>
    </div>
  );
}
const CARDS = { receipts: ReceiptsCard, tracker: TrackerCard, multipick: MultiPickCard, quickadd: QuickAddCard, pricing: PricingCard };

const FEATURES = [
  { k: "receipts", tag: "Receipts · live track record", title: "We log every leg.\nYou see every miss.", body: "When MultiPick rates a leg 80% likely, it should hit ~80% of the time. Our last 328 calls — no cherry-picking, no curated highlights.", note: "Calibrating · Updates weekly · Every prediction included" },
  { k: "tracker", tag: "01 — Tracker", title: "Your bets,\nby the numbers.", body: "Profit/loss · win rate · ROI · in-flight exposure — at every cadence (week, month, year), charted automatically.", note: "Cumulative P/L · Sport-by-sport edge · Form heatmap" },
  { k: "multipick", tag: "02 — MultiPick", title: "Multis backed\nby real form.", body: "Recent form, live market lines and a transparent edge model — example multis with honest +EV. Refine by chat: \"swap leg 2\", \"around $3\".", note: "Last-5/10 hit rates · Edge vs the book · Correlation-aware" },
  { k: "quickadd", tag: "03 — Quick add", title: "Paste a screenshot.\nWe do the rest.", body: "Drop or paste a betslip from any Aussie bookmaker. AI vision reads the stake, odds and every leg — then pre-fills your Add Bet form.", note: "Sportsbet · PointsBet · TAB · Ladbrokes · Bet365 · Neds" },
  { k: "pricing", tag: "Pricing", title: "Start free.\nUpgrade when ready.", body: "Everything you need to track for free — or unlock unlimited MultiPick on Pickd Pro. Founding price locked in forever.", note: "Cancel anytime · No long-term commitment" },
];

function FeatureSection({ f, scrollRoot, flip, stacked }) {
  const ref = useRef(), [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ob = new IntersectionObserver(([e]) => setInView(e.intersectionRatio > 0.4), { root: scrollRoot.current, threshold: [0, 0.4, 0.7] });
    ob.observe(el); return () => ob.disconnect();
  }, [scrollRoot]);
  const Card = CARDS[f.k];
  // Desktop: heading one side, card the other; card flies in from its side.
  // Stacked (mobile): heading on top, full-width card below with a gentle rise-in.
  return (
    <section ref={ref} style={{ minHeight: stacked ? "auto" : "100vh", display: "flex", flexDirection: stacked ? "column" : (flip ? "row-reverse" : "row"), alignItems: stacked ? "stretch" : "center", justifyContent: stacked ? "center" : "space-between", gap: stacked ? 28 : "4vw", padding: stacked ? "9vh 22px" : "10vh 7vw", boxSizing: "border-box", scrollSnapAlign: "start" }}>
      <div style={{ flex: stacked ? "none" : "0 1 440px", color: "#e9e9ec", pointerEvents: "none", textAlign: stacked ? "left" : (flip ? "right" : "left") }}>
        <div style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: LIME, marginBottom: 14 }}>{f.tag}</div>
        <h2 style={{ fontSize: stacked ? "clamp(31px,8.5vw,42px)" : "clamp(34px,4.4vw,60px)", lineHeight: 0.98, letterSpacing: "-0.03em", fontWeight: 700, margin: "0 0 18px", whiteSpace: "pre-line" }}>{f.title.replace(/\.\s*$/, "")}<span style={{ color: LIME }}>.</span></h2>
        <p style={{ fontSize: stacked ? 15.5 : 17, lineHeight: 1.55, color: "#c2c2c9", maxWidth: stacked ? "none" : 430, margin: !stacked && flip ? "0 0 22px auto" : "0 0 22px" }}>{f.body}</p>
        <div style={{ fontSize: 12.5, color: "#6f6f79", letterSpacing: "0.02em" }}>{f.note}</div>
      </div>
      <div style={{ flex: stacked ? "none" : "0 1 540px", width: stacked ? "100%" : undefined, maxWidth: stacked ? "100%" : 560, perspective: 1200, pointerEvents: "auto" }}>
        <div style={{ transformStyle: "preserve-3d", transform: inView ? "none" : (stacked ? "translateY(26px)" : `translateX(${flip ? -80 : 80}px) translateY(20px) rotateY(${flip ? 16 : -16}deg)`), opacity: inView ? 1 : 0, transition: "transform 1s cubic-bezier(.2,.7,.2,1), opacity .8s ease" }}>
          <Card narrow={stacked} />
        </div>
      </div>
    </section>
  );
}

const FAQS = [
  ["Is this a tipping service?", "No. Pickd shows you the maths — recent form, edge vs the market, and a calibrated hit-rate — not 'locks'. Informational analysis, never betting advice."],
  ["Do you accept bets?", "Never. Pickd doesn't hold money or take wagers. You bet with your own bookmaker; we just help you track and analyse what you've placed."],
  ["What sports?", "AFL and NBA today, with more leagues on the way."],
  ["How does the AI work?", "MultiPick reads last-5 and last-10 form from real game logs, compares it to live market lines, and builds example multis with honest edge — then logs every call against the result."],
  ["Refund policy?", "Pro is billed weekly with no lock-in — cancel anytime from Settings and you keep access until the period ends."],
  ["Is my data private?", "Yes. Your bets and history are yours. We don't sell your data, and you can export or delete it whenever you like."],
];
function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "1px solid #1d1d25" }}>
      <button onClick={() => setOpen((o) => !o)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, background: "transparent", border: "none", color: "#e9e9ec", fontSize: 18, fontWeight: 500, padding: "20px 0", cursor: "pointer", textAlign: "left" }}>
        <span>{q}</span><span style={{ color: LIME, fontSize: 22, lineHeight: 1, transition: "transform .2s" }}>{open ? "−" : "+"}</span>
      </button>
      {open ? <p style={{ color: "#9a9aa4", fontSize: 15, lineHeight: 1.55, margin: "-4px 0 20px", maxWidth: 620 }}>{a}</p> : null}
    </div>
  );
}
function FAQSection({ stacked }) {
  return (
    <section style={{ minHeight: stacked ? "auto" : "100vh", display: "flex", flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "center", justifyContent: stacked ? "center" : "space-between", gap: stacked ? 22 : "5vw", padding: stacked ? "9vh 22px" : "10vh 7vw", boxSizing: "border-box", scrollSnapAlign: "start" }}>
      <div style={{ flex: stacked ? "none" : "0 1 360px", color: "#e9e9ec", pointerEvents: "none" }}>
        <div style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: LIME, marginBottom: 14 }}>FAQ</div>
        <h2 style={{ fontSize: stacked ? "clamp(31px,8.5vw,42px)" : "clamp(34px,4.4vw,60px)", lineHeight: 0.98, letterSpacing: "-0.03em", fontWeight: 700, margin: 0 }}>Questions,<br />answered<span style={{ color: LIME }}>.</span></h2>
      </div>
      <div style={{ flex: stacked ? "none" : "0 1 640px", maxWidth: stacked ? "100%" : 680, pointerEvents: "auto" }}>
        {FAQS.map(([q, a]) => <FAQItem key={q} q={q} a={a} />)}
      </div>
    </section>
  );
}
function FinalCTASection() {
  return (
    <section style={{ minHeight: "100vh", display: "flex", flexDirection: "column", scrollSnapAlign: "start" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "12vh 7vw 0", color: "#e9e9ec" }}>
        <div style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: LIME, marginBottom: 24 }}>● Last word</div>
        <h2 style={{ fontSize: "clamp(46px,7.5vw,100px)", lineHeight: 0.95, letterSpacing: "-0.04em", fontWeight: 700, margin: "0 0 24px" }}>Bet smart<span style={{ color: LIME }}>.</span><br />Track smarter<span style={{ color: LIME }}>.</span></h2>
        <p style={{ fontSize: 18, color: "#c2c2c9", maxWidth: 540, margin: "0 0 30px" }}>Free to start. Three MultiPick builds a week. Unlimited bet tracking. No card required.</p>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", pointerEvents: "auto" }}>
          <button onClick={() => cta.startFree()} style={{ background: LIME, color: "#0a0a0b", fontWeight: 700, fontSize: 15, border: "none", borderRadius: 12, padding: "14px 26px", cursor: "pointer" }}>Start free →</button>
          <button onClick={() => cta.login()} style={{ background: "transparent", color: "#e9e9ec", fontWeight: 600, fontSize: 15, border: "1px solid #2a2a31", borderRadius: 12, padding: "14px 26px", cursor: "pointer" }}>I have an account</button>
        </div>
        <div style={{ marginTop: 22, fontSize: 12.5, color: "#6f6f79" }}>18+ · Gamble responsibly · Pickd does not accept bets</div>
      </div>
      <footer style={{ borderTop: "1px solid #1d1d25", padding: "26px 7vw", display: "flex", flexWrap: "wrap", gap: 20, justifyContent: "space-between", alignItems: "flex-start", pointerEvents: "auto" }}>
        <div style={{ maxWidth: 520 }}>
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, color: "#e9e9ec" }}>Pickd<span style={{ color: LIME }}>.</span></div>
          <div style={{ fontSize: 12, color: "#6f6f79", lineHeight: 1.5 }}>Pickd is an analytics tool for tracking sports betting activity. Informational only — not betting advice, not a tipping service, does not accept wagers. © 2026 Pickd.</div>
        </div>
        <div style={{ display: "flex", gap: 24, fontSize: 13, color: "#9a9aa4", flexWrap: "wrap" }}>
          <span>Disclaimer</span><span>Responsible Gambling</span><span>Privacy</span><span>Terms</span>
        </div>
      </footer>
    </section>
  );
}

function HeroSection() {
  return (
    <section style={{ position: "relative", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "0 7vw", color: "#e9e9ec", pointerEvents: "none", scrollSnapAlign: "start" }}>
      {/* soft green glow behind the hero */}
      <div style={{ position: "absolute", top: "47%", left: "50%", transform: "translate(-50%,-50%)", width: 680, height: 680, maxWidth: "92vw", borderRadius: "50%", background: "radial-gradient(circle, rgba(212,242,58,0.17) 0%, rgba(212,242,58,0.06) 36%, transparent 68%)", pointerEvents: "none" }} />
      <span style={{ position: "relative", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: LIME, border: `1px solid ${LIME}55`, borderRadius: 999, padding: "5px 12px", marginBottom: 22 }}>AI Multi Builder</span>
      <h1 style={{ position: "relative", fontSize: "clamp(54px,9vw,120px)", lineHeight: 0.95, letterSpacing: "-0.04em", fontWeight: 700, margin: "0 0 18px" }}>Pickd<span style={{ color: LIME }}>.</span></h1>
      <p style={{ position: "relative", fontSize: "clamp(16px,2vw,21px)", lineHeight: 1.5, color: "#c2c2c9", maxWidth: 520, margin: "0 0 30px" }}>One AI brain behind every tool — multi builder, tracker, betslip OCR. Scroll to explore.</p>
      <div style={{ position: "relative", display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", pointerEvents: "auto" }}>
        <button onClick={() => cta.startFree()} style={{ background: LIME, color: "#0a0a0b", fontWeight: 700, fontSize: 14, border: "none", borderRadius: 12, padding: "13px 22px", cursor: "pointer" }}>Build a multi →</button>
        <button onClick={() => cta.explore()} style={{ background: "rgba(10,10,11,0.5)", color: "#e9e9ec", fontWeight: 600, fontSize: 14, border: "1px solid #2a2a31", borderRadius: 12, padding: "13px 22px", cursor: "pointer" }}>See how it works</button>
      </div>
      <div style={{ position: "absolute", bottom: 32, left: 0, right: 0, textAlign: "center", fontSize: 12, letterSpacing: "0.16em", textTransform: "uppercase", color: "#5f5f6a" }}>Scroll to explore ↓</div>
    </section>
  );
}

// Staging-only banner. Hidden on the live landing (staging=false). The 3D/2D chips link
// to /preview and /preview/2d so both variants can be eyeballed before launch.
export function PreviewBanner({ which = "3d" }) {
  const chip = (href, l, active) => <a href={href} style={{ background: active ? LIME : "transparent", color: active ? "#0a0a0b" : "#9a9aa4", borderRadius: 7, padding: "4px 11px", fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: "0.04em", textDecoration: "none" }}>{l}</a>;
  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 16px", background: "rgba(10,10,11,0.7)", backdropFilter: "blur(10px)", borderBottom: "1px solid #1d1d25" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#9a9aa4" }}><span style={{ width: 7, height: 7, borderRadius: 999, background: LIME, boxShadow: `0 0 8px ${LIME}` }} />Preview Mode · Pickd landing <span style={{ color: "#5f5f6a" }}>(staging — not live)</span></div>
      <div style={{ display: "flex", gap: 3, background: "rgba(255,255,255,0.04)", borderRadius: 9, padding: 3 }}>{chip("/preview", "3D", which === "3d")}{chip("/preview/2d", "2D", which === "2d")}</div>
    </div>
  );
}

// The scrollable page body, shared by both landings. `scrollRoot` is the scrolling
// container ref (used by each FeatureSection's IntersectionObserver).
export function LandingContent({ scrollRoot, stacked }) {
  return (
    <>
      <HeroSection />
      {FEATURES.map((f, i) => <FeatureSection key={f.k} f={f} scrollRoot={scrollRoot} flip={i % 2 === 1} stacked={stacked} />)}
      <FAQSection stacked={stacked} />
      <FinalCTASection />
    </>
  );
}
