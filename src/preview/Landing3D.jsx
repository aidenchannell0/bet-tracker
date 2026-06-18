// Pickd — 3D landing PROTOTYPE (staging only, behind /preview).
// Architecture: a FIXED, orbiting neural-brain canvas as the living backdrop; your real
// landing sections (heading left · detailed data-card right) scroll OVER it, each card flying
// in from an angle. Scroll drives the camera's orbit around the brain. Star-dust kept.
// Graceful 2D fallback + Preview-Mode banner. Lazy-loaded so the live app never ships Three.js.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import { useRef, useMemo, useState, useEffect, Suspense } from "react";
import * as THREE from "three";

const LIME = "#d4f23a";
const BG = "#0a0a0b";

/* ── shared bits ── */
function useSprite() {
  return useMemo(() => {
    const s = 64, c = document.createElement("canvas"); c.width = c.height = s;
    const ctx = c.getContext("2d"), g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,255,255,0.55)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }, []);
}
const pointer = { x: 0, y: 0 };
if (typeof window !== "undefined") window.addEventListener("pointermove", (e) => { pointer.x = e.clientX / window.innerWidth - 0.5; pointer.y = e.clientY / window.innerHeight - 0.5; }, { passive: true });

/* ── star-dust ── */
function Particles({ count = 1400 }) {
  const ref = useRef(), sprite = useSprite();
  const [positions, colors] = useMemo(() => {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    const lime = new THREE.Color(LIME), white = new THREE.Color("#cfd2c8"), grey = new THREE.Color("#5f5f68");
    for (let i = 0; i < count; i++) {
      const r = 4 + Math.random() * 18, th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * r; pos[i * 3 + 1] = Math.cos(ph) * r * 0.8; pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r;
      const c = Math.random() < 0.16 ? lime : Math.random() < 0.5 ? white : grey;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    return [pos, col];
  }, [count]);
  useFrame((_, dt) => { const g = ref.current; if (g) { g.rotation.y += dt * 0.01; g.rotation.x += (pointer.y * 0.1 - g.rotation.x) * 0.02; } });
  return (
    <points ref={ref}>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /><bufferAttribute attach="attributes-color" args={[colors, 3]} /></bufferGeometry>
      <pointsMaterial size={0.08} map={sprite} vertexColors transparent opacity={0.9} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
}

/* ── neural network of pulses that walk the graph through the brain ── */
function makeNet(M) {
  const nodes = [];
  for (let i = 0; i < M; i++) {
    let x, y, z, m; do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; m = x * x + y * y + z * z; } while (m > 1);
    const lobe = i % 2 ? 1 : -1, r = 0.45 + Math.random() * 0.5;
    nodes.push(new THREE.Vector3(lobe * 0.4 + x * 0.5 * r, y * 0.66 * r, z * 0.86 * r));
  }
  const edges = [], seen = new Set();
  for (let i = 0; i < M; i++) {
    const near = nodes.map((n, j) => ({ j, d: nodes[i].distanceToSquared(n) })).filter((o) => o.j !== i).sort((a, b) => a.d - b.d);
    for (let k = 0; k < 3; k++) { const j = near[k].j, key = i < j ? `${i}-${j}` : `${j}-${i}`; if (!seen.has(key)) { seen.add(key); edges.push([i, j]); } }
  }
  const adj = nodes.map(() => []);
  edges.forEach(([a, b]) => { adj[a].push(b); adj[b].push(a); });
  return { nodes, adj };
}

/* ── real anatomical brain (MIT model) re-skinned as a glowing lime wireframe ── */
function Brain() {
  const group = useRef(), pulseRef = useRef(), sprite = useSprite();
  const { scene } = useGLTF("/brain.glb");
  const brain = useMemo(() => {
    const c = scene.clone(true);
    const box = new THREE.Box3().setFromObject(c), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const scale = 3.0 / (Math.max(size.x, size.y, size.z) || 1);
    // Clip the brain STEM off the bottom: drop the lower ~33% of the model. World-space Y plane
    // (after centring + scale; the group's Y-spin doesn't affect a horizontal cut).
    const clipWorldY = (0.39 - 0.5) * size.y * scale;
    const stemPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -clipWorldY);
    c.traverse((o) => { if (o.isMesh) { o.material = new THREE.MeshBasicMaterial({ color: LIME, wireframe: true, transparent: true, opacity: 0.13, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending, clippingPlanes: [stemPlane] }); o.frustumCulled = false; } });
    return { obj: c, scale, cx: center.x, cy: center.y, cz: center.z };
  }, [scene]);
  const net = useMemo(() => makeNet(54), []);
  const pulses = useRef(Array.from({ length: 16 }, () => { const from = (Math.random() * net.nodes.length) | 0, nb = net.adj[from]; return { from, to: nb.length ? nb[(Math.random() * nb.length) | 0] : from, t: Math.random() }; }));
  useFrame((s, dt) => {
    if (group.current) group.current.rotation.y += dt * 0.05;
    const pp = pulseRef.current; if (!pp) return; const arr = pp.geometry.attributes.position.array;
    pulses.current.forEach((pl, i) => {
      pl.t += dt * 0.4;
      while (pl.t > 1) { pl.t -= 1; pl.from = pl.to; const nb = net.adj[pl.from]; pl.to = nb.length ? nb[(Math.random() * nb.length) | 0] : pl.from; }
      const A = net.nodes[pl.from], B = net.nodes[pl.to];
      arr[i * 3] = A.x + (B.x - A.x) * pl.t; arr[i * 3 + 1] = A.y + (B.y - A.y) * pl.t; arr[i * 3 + 2] = A.z + (B.z - A.z) * pl.t;
    });
    pp.geometry.attributes.position.needsUpdate = true;
  });
  return (
    <group ref={group}>
      <group scale={brain.scale}><primitive object={brain.obj} position={[-brain.cx, -brain.cy, -brain.cz]} /></group>
      <group scale={1.25}>
        <points ref={pulseRef}>
          <bufferGeometry><bufferAttribute attach="attributes-position" args={[new Float32Array(pulses.current.length * 3), 3]} /></bufferGeometry>
          <pointsMaterial color="#ffffff" size={0.16} map={sprite} sizeAttenuation transparent depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
        </points>
      </group>
    </group>
  );
}
useGLTF.preload("/brain.glb");

/* ── camera ORBITS the brain as you scroll (scrollRef = page progress 0..1) ── */
function Rig({ scrollRef }) {
  const { camera } = useThree();
  useFrame((_, dt) => {
    const o = scrollRef.current || 0;                 // raw scroll; CSS snap keeps it smooth between sections
    const az = -0.45 + o * 3.3;                       // orbit ~190° around the brain
    const rad = 8.2 - Math.sin(o * Math.PI) * 1.7;    // dip closer through the middle
    const k = Math.min(1, dt * 7);                    // single responsive follow (no laggy double-smoothing)
    camera.position.x += (Math.sin(az) * rad + pointer.x * 0.5 - camera.position.x) * k;
    camera.position.y += (0.5 - o * 0.4 - pointer.y * 0.3 - camera.position.y) * k;
    camera.position.z += (Math.cos(az) * rad - camera.position.z) * k;
    camera.lookAt(0, 0.05, 0);
  });
  return null;
}

function Scene({ scrollRef }) {
  return (
    <>
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 11, 34]} />
      <Particles count={3400} />
      {/* <Brain />  — toggled off to preview dust-only */}
      <Rig scrollRef={scrollRef} />
      <EffectComposer disableNormalPass>
        <Bloom intensity={0.85} luminanceThreshold={0.2} luminanceSmoothing={0.9} mipmapBlur />
        <Vignette offset={0.3} darkness={0.82} />
      </EffectComposer>
    </>
  );
}

/* ─────────────────────────── HTML LAYER (your real sections) ─────────────────────────── */
const card = { position: "relative", borderRadius: 22, border: "1px solid #23242b", background: "rgba(11,12,16,0.72)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", padding: "26px 28px", boxShadow: "0 30px 80px rgba(0,0,0,0.45)" };
const label = { fontSize: 10.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "#6f6f79", fontWeight: 600 };
const mono = { fontFamily: "ui-monospace, 'JetBrains Mono', monospace" };

function ReceiptsCard() {
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 22 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>MultiPick<span style={{ color: LIME }}>.</span> hit rate</div>
        <div style={label}>Last 328 picks</div>
      </div>
      <div style={label}>Actual hit rate</div>
      <div style={{ ...mono, fontSize: 84, fontWeight: 700, color: "#5bd06a", lineHeight: 1, margin: "6px 0 8px" }}>82%</div>
      <div style={{ fontSize: 14, color: "#9a9aa4" }}><b style={{ color: "#e9e9ec" }}>269</b> of <b style={{ color: "#e9e9ec" }}>328</b> legs hit their line</div>
      <div style={{ display: "flex", gap: 40, marginTop: 26, paddingTop: 22, borderTop: "1px solid #1d1d25" }}>
        <div><div style={label}>We predicted</div><div style={{ ...mono, fontSize: 30, fontWeight: 700, marginTop: 4 }}>89%</div><div style={{ fontSize: 11.5, color: "#6f6f79", marginTop: 2 }}>Average confidence</div></div>
        <div><div style={label}>Gap</div><div style={{ ...mono, fontSize: 30, fontWeight: 700, marginTop: 4 }}>±7%</div><div style={{ fontSize: 11.5, color: "#6f6f79", marginTop: 2 }}>Prediction vs reality</div></div>
      </div>
    </div>
  );
}
function TrackerCard() {
  const form = "WWLWWWWLWWLWWWLWWWWL";
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}><div style={label}>Dashboard · April 2026</div><div style={{ ...label, color: LIME }}>● Live</div></div>
      <div style={{ display: "flex", gap: 26, flexWrap: "wrap", marginBottom: 24 }}>
        {[["Profit / loss", "+$246.50", "#5bd06a"], ["Win rate", "58.3%", "#e9e9ec"], ["Return on stake", "+12.8%", "#5bd06a"], ["In flight", "$84.00", "#e9e9ec"]].map(([l, v, c]) => (
          <div key={l}><div style={label}>{l}</div><div style={{ ...mono, fontSize: 24, fontWeight: 700, color: c, marginTop: 4 }}>{v}</div></div>
        ))}
      </div>
      <div style={{ ...label, marginBottom: 8 }}>Cumulative P/L · 12 weeks</div>
      <svg viewBox="0 0 320 70" style={{ width: "100%", height: 64, display: "block", marginBottom: 22 }} preserveAspectRatio="none">
        <polyline points="0,60 30,52 60,55 90,42 120,46 150,34 180,30 210,22 240,26 270,14 300,8 320,4" fill="none" stroke="#5bd06a" strokeWidth="2" />
        <polyline points="0,60 30,52 60,55 90,42 120,46 150,34 180,30 210,22 240,26 270,14 300,8 320,4 320,70 0,70" fill="rgba(91,208,106,0.12)" stroke="none" />
      </svg>
      <div style={{ ...label, marginBottom: 8 }}>Recent form · last 20</div>
      <div style={{ display: "flex", gap: 4 }}>{form.split("").map((r, i) => <div key={i} style={{ width: 13, height: 16, borderRadius: 3, background: r === "W" ? "#3f9d4e" : "#a04646" }} />)}</div>
    </div>
  );
}
function MultiPickCard() {
  const legs = [["M. Bontempelli", "25+ disposals", "9/10", "79%", "+7% value", "$1.38"], ["C. Curnow", "1+ goals", "8/10", "84%", "+3% value", "$1.30"], ["T. Stengle", "20+ disposals", "8/10", "76%", "−2% edge", "$1.18"]];
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div><div style={label}>MultiPick output · example</div><div style={{ fontSize: 21, fontWeight: 700, marginTop: 6 }}>3-leg AFL multi</div><div style={{ fontSize: 12.5, color: "#9a9aa4", marginTop: 2 }}>Geelong vs Carlton · 7:50pm</div></div>
        <div style={{ textAlign: "right", border: "1px solid #2a2a31", borderRadius: 12, padding: "8px 12px" }}><div style={{ ...label, fontSize: 9.5 }}>Combined</div><div style={{ ...mono, fontSize: 22, fontWeight: 700 }}>$2.12</div><div style={{ fontSize: 10.5, color: "#6f6f79" }}>~48% chance</div></div>
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
      <div style={{ ...label, marginBottom: 14 }}>Quick add · AI vision</div>
      <div style={{ fontSize: 16, lineHeight: 1.5, marginBottom: 18 }}>Drop, paste, or upload a betslip screenshot — <span style={{ color: "#9a9aa4" }}>we'll read the stake, odds and legs and fill the form for you.</span></div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "#6f6f79", marginBottom: 20 }}><span style={{ ...mono, border: "1px solid #2a2a31", borderRadius: 6, padding: "3px 8px" }}>⌘V</span> to paste · or click anywhere to upload</div>
      <div style={{ display: "flex", gap: 34, paddingTop: 18, borderTop: "1px solid #1d1d25" }}>
        {[["Stake", "$25.00"], ["Odds", "$4.20"], ["Legs", "3"]].map(([l, v]) => <div key={l}><div style={label}>{l}</div><div style={{ ...mono, fontSize: 24, fontWeight: 700, marginTop: 4 }}>{v}</div></div>)}
      </div>
    </div>
  );
}
function PricingCard() {
  return (
    <div style={{ display: "flex", gap: 14 }}>
      <div style={{ ...card, flex: 1, padding: "22px 22px" }}>
        <div style={label}>Free</div>
        <div style={{ ...mono, fontSize: 40, fontWeight: 700, margin: "4px 0 14px" }}>$0<span style={{ fontSize: 14, color: "#6f6f79", fontWeight: 400 }}> forever</span></div>
        {["Unlimited bet tracking", "Full analytics", "Betslip OCR", "3 MultiPick / week"].map((t) => <div key={t} style={{ fontSize: 13, color: "#9a9aa4", padding: "4px 0" }}>· {t}</div>)}
      </div>
      <div style={{ ...card, flex: 1, padding: "22px 22px", border: `1px solid ${LIME}`, boxShadow: `0 30px 80px rgba(212,242,58,0.12)` }}>
        <div style={{ ...label, color: LIME }}>Pickd Pro · founding</div>
        <div style={{ ...mono, fontSize: 40, fontWeight: 700, margin: "4px 0 4px" }}>$4.99<span style={{ fontSize: 14, color: "#6f6f79", fontWeight: 400 }}> /wk</span></div>
        <div style={{ fontSize: 11, color: LIME, marginBottom: 12 }}>🔒 13 spots left · locked in forever</div>
        {["Everything in Free", "Unlimited MultiPick", "Priority support", "Early access"].map((t) => <div key={t} style={{ fontSize: 13, color: "#c2c2c9", padding: "4px 0" }}>· {t}</div>)}
        <button style={{ marginTop: 12, width: "100%", background: LIME, color: "#0a0a0b", fontWeight: 700, fontSize: 14, border: "none", borderRadius: 12, padding: "12px", cursor: "pointer" }}>Upgrade to Pro →</button>
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

function FeatureSection({ f, scrollRoot, flip }) {
  const ref = useRef(), [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ob = new IntersectionObserver(([e]) => setInView(e.intersectionRatio > 0.4), { root: scrollRoot.current, threshold: [0, 0.4, 0.7] });
    ob.observe(el); return () => ob.disconnect();
  }, [scrollRoot]);
  const Card = CARDS[f.k];
  // flip → card on the left, text on the right; card flies in from the matching side.
  return (
    <section ref={ref} style={{ minHeight: "100vh", display: "flex", flexDirection: flip ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between", gap: "4vw", padding: "10vh 7vw", boxSizing: "border-box", scrollSnapAlign: "start" }}>
      <div style={{ flex: "0 1 440px", color: "#e9e9ec", pointerEvents: "none", textAlign: flip ? "right" : "left" }}>
        <div style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: LIME, marginBottom: 14 }}>{f.tag}</div>
        <h2 style={{ fontSize: "clamp(34px,4.4vw,60px)", lineHeight: 0.98, letterSpacing: "-0.03em", fontWeight: 700, margin: "0 0 18px", whiteSpace: "pre-line" }}>{f.title.replace(/\.\s*$/, "")}<span style={{ color: LIME }}>.</span></h2>
        <p style={{ fontSize: 17, lineHeight: 1.55, color: "#c2c2c9", maxWidth: 430, margin: flip ? "0 0 22px auto" : "0 0 22px" }}>{f.body}</p>
        <div style={{ fontSize: 12.5, color: "#6f6f79", letterSpacing: "0.02em" }}>{f.note}</div>
      </div>
      <div style={{ flex: "0 1 540px", maxWidth: 560, perspective: 1200, pointerEvents: "auto" }}>
        <div style={{ transformStyle: "preserve-3d", transform: inView ? "none" : `translateX(${flip ? -80 : 80}px) translateY(20px) rotateY(${flip ? 16 : -16}deg)`, opacity: inView ? 1 : 0, transition: "transform 1s cubic-bezier(.2,.7,.2,1), opacity .8s ease" }}>
          <Card />
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
function FAQSection() {
  return (
    <section style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "5vw", padding: "10vh 7vw", boxSizing: "border-box", scrollSnapAlign: "start" }}>
      <div style={{ flex: "0 1 360px", color: "#e9e9ec", pointerEvents: "none" }}>
        <div style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: LIME, marginBottom: 14 }}>FAQ</div>
        <h2 style={{ fontSize: "clamp(34px,4.4vw,60px)", lineHeight: 0.98, letterSpacing: "-0.03em", fontWeight: 700, margin: 0 }}>Questions,<br />answered<span style={{ color: LIME }}>.</span></h2>
      </div>
      <div style={{ flex: "0 1 640px", maxWidth: 680, pointerEvents: "auto" }}>
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
          <button style={{ background: LIME, color: "#0a0a0b", fontWeight: 700, fontSize: 15, border: "none", borderRadius: 12, padding: "14px 26px", cursor: "pointer" }}>Start free →</button>
          <button style={{ background: "transparent", color: "#e9e9ec", fontWeight: 600, fontSize: 15, border: "1px solid #2a2a31", borderRadius: 12, padding: "14px 26px", cursor: "pointer" }}>I have an account</button>
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
        <button style={{ background: LIME, color: "#0a0a0b", fontWeight: 700, fontSize: 14, border: "none", borderRadius: 12, padding: "13px 22px", cursor: "pointer" }}>Build a multi →</button>
        <button style={{ background: "rgba(10,10,11,0.5)", color: "#e9e9ec", fontWeight: 600, fontSize: 14, border: "1px solid #2a2a31", borderRadius: 12, padding: "13px 22px", cursor: "pointer" }}>See how it works</button>
      </div>
      <div style={{ position: "absolute", bottom: 32, left: 0, right: 0, textAlign: "center", fontSize: 12, letterSpacing: "0.16em", textTransform: "uppercase", color: "#5f5f6a" }}>Scroll to explore ↓</div>
    </section>
  );
}

function PreviewBanner({ mode, setMode }) {
  const seg = (val, l) => <button onClick={() => setMode(val)} style={{ background: mode === val ? LIME : "transparent", color: mode === val ? "#0a0a0b" : "#9a9aa4", border: "none", borderRadius: 7, padding: "4px 11px", fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: "0.04em" }}>{l}</button>;
  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 16px", background: "rgba(10,10,11,0.7)", backdropFilter: "blur(10px)", borderBottom: "1px solid #1d1d25" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#9a9aa4" }}><span style={{ width: 7, height: 7, borderRadius: 999, background: LIME, boxShadow: `0 0 8px ${LIME}` }} />Preview Mode · Pickd 3D landing <span style={{ color: "#5f5f6a" }}>(staging — not live)</span></div>
      <div style={{ display: "flex", gap: 3, background: "rgba(255,255,255,0.04)", borderRadius: 9, padding: 3 }}>{seg("auto", "AUTO")}{seg("3d", "3D")}{seg("2d", "2D")}</div>
    </div>
  );
}
function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== "undefined" && (window.innerWidth < 880 || window.matchMedia("(prefers-reduced-motion: reduce)").matches));
  useEffect(() => { const f = () => setM(window.innerWidth < 880 || window.matchMedia("(prefers-reduced-motion: reduce)").matches); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  return m;
}

export default function Landing3D() {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState("auto");
  const show2D = mode === "2d" || (mode === "auto" && isMobile);
  const scrollRef = useRef(0);
  const rootRef = useRef(null);
  return (
    <div style={{ position: "fixed", inset: 0, background: BG, overflow: "hidden" }}>
      <PreviewBanner mode={mode} setMode={setMode} />
      {!show2D && (
        <div style={{ position: "fixed", inset: 0, zIndex: 0 }}>
          <Canvas dpr={[1, 2]} camera={{ position: [0, 0.5, 8.2], fov: 45 }} gl={{ antialias: true, powerPreference: "high-performance" }} onCreated={({ gl }) => { gl.localClippingEnabled = true; }}>
            <Suspense fallback={null}><Scene scrollRef={scrollRef} /></Suspense>
          </Canvas>
        </div>
      )}
      <div style={{ position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none", background: show2D ? `radial-gradient(900px 520px at 72% 12%, ${LIME}10, transparent 60%)` : "linear-gradient(90deg, rgba(10,10,11,0.62) 0%, rgba(10,10,11,0.12) 27%, rgba(10,10,11,0) 50%, rgba(10,10,11,0.12) 73%, rgba(10,10,11,0.62) 100%)" }} />
      <div ref={rootRef} onScroll={(e) => { const el = e.currentTarget; scrollRef.current = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight); }} style={{ position: "absolute", inset: 0, overflowY: "auto", overflowX: "hidden", zIndex: 2, scrollSnapType: "y mandatory" }}>
        <HeroSection />
        {FEATURES.map((f, i) => <FeatureSection key={f.k} f={f} scrollRoot={rootRef} flip={i % 2 === 1} />)}
        <FAQSection />
        <FinalCTASection />
      </div>
    </div>
  );
}
