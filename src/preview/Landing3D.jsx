// Pickd — 3D landing PROTOTYPE (staging only, behind /preview).
// Concept: a folded neural BRAIN at the centre; your real landing features orbit it
// like planets; scrolling flies the camera on an orbital tour, visiting each one.
// Star-dust field kept. Graceful 2D fallback + Preview-Mode banner. Lazy-loaded so
// the live app never ships Three.js. (Brain is stylised/procedural — swap a real
// anatomical .glb in later for medical detail.)
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ScrollControls, Scroll, useScroll, Float, RoundedBox, Edges, Line } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import { useRef, useMemo, useState, useEffect, Suspense } from "react";
import * as THREE from "three";

const LIME = "#d4f23a";
const BG = "#0a0a0b";
const d2r = (d) => (d * Math.PI) / 180;

/* ── your real landing features → the orbiting "planets" ── */
const R_PL = 4.3, R_CAM = 7.3;
const FEATURES = [
  { k: "gauge", a: 55, h: 1.15, tag: "Receipts · live track record", title: "We log every leg.\nYou see every miss.", body: "When MultiPick rates a leg 80% likely, it should hit ~80% of the time. Last 328 calls — no cherry-picking.", stats: [["Actual", "82%"], ["Predicted", "89%"], ["Gap", "±7%"]] },
  { k: "graph", a: 122, h: -1.25, tag: "01 · Tracker", title: "Your bets,\nby the numbers.", body: "Profit/loss · win rate · ROI · in-flight — at every cadence, charted automatically.", stats: [["P/L", "+$246"], ["Win rate", "58.3%"], ["ROI", "+12.8%"]] },
  { k: "multi", a: 188, h: 1.3, tag: "02 · MultiPick", title: "Multis backed\nby real form.", body: "Recent form, live market lines and a transparent edge model — example multis with honest +EV.", stats: [["Example", "$2.12"], ["Chance", "~48%"], ["Legs", "3"]] },
  { k: "scan", a: 250, h: -1.05, tag: "03 · Quick add", title: "Paste a screenshot.\nWe do the rest.", body: "AI vision reads the stake, odds and every leg from any Aussie betslip — then fills the form.", stats: [["Stake", "$25"], ["Odds", "$4.20"], ["Legs", "3"]] },
  { k: "pricing", a: 314, h: 0.75, tag: "Pricing", title: "Start free.\nUpgrade when ready.", body: "Everything you need to track for free — or unlock unlimited MultiPick on Pickd Pro.", stats: [["Free", "$0"], ["Pro", "$4.99"], ["Founding", "13 left"]], cta: "Upgrade to Pro →" },
];
const planetPos = (f) => [Math.sin(d2r(f.a)) * R_PL, f.h, Math.cos(d2r(f.a)) * R_PL];
const stationFor = (f) => { const ca = d2r(f.a + 14), p = planetPos(f); return { pos: [Math.sin(ca) * R_CAM, f.h * 0.5 + 0.6, Math.cos(ca) * R_CAM], look: [p[0] * 0.42, f.h * 0.45, p[2] * 0.42] }; };
const STATIONS = [{ pos: [0, 0.5, 7.9], look: [0, 0.1, 0] }, ...FEATURES.map(stationFor)];

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
function usePointer() {
  const p = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const f = (e) => { p.current.x = e.clientX / window.innerWidth - 0.5; p.current.y = e.clientY / window.innerHeight - 0.5; };
    window.addEventListener("pointermove", f, { passive: true });
    return () => window.removeEventListener("pointermove", f);
  }, []);
  return p;
}

/* ── star-dust (kept) ── */
function Particles({ count = 1400 }) {
  const ref = useRef(), sprite = useSprite(), pointer = usePointer();
  const [positions, colors] = useMemo(() => {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    const lime = new THREE.Color(LIME), white = new THREE.Color("#cfd2c8"), grey = new THREE.Color("#5f5f68");
    for (let i = 0; i < count; i++) {
      const r = 6 + Math.random() * 13, th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
      pos[i * 3] = Math.sin(ph) * Math.cos(th) * r; pos[i * 3 + 1] = Math.cos(ph) * r * 0.8; pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r;
      const c = Math.random() < 0.16 ? lime : Math.random() < 0.5 ? white : grey;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    return [pos, col];
  }, [count]);
  useFrame((_, dt) => { const g = ref.current; if (g) { g.rotation.y += dt * 0.01; g.rotation.x += (pointer.current.y * 0.12 - g.rotation.x) * 0.03; } });
  return (
    <points ref={ref}>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /><bufferAttribute attach="attributes-color" args={[colors, 3]} /></bufferGeometry>
      <pointsMaterial size={0.08} map={sprite} vertexColors transparent opacity={0.9} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
}

/* ── procedural folded brain: dense surface cloud + neural net + pulses ── */
const fold = (x, y, z) => 1 + 0.085 * Math.sin(x * 9 + z * 7) * Math.cos(y * 8) + 0.05 * Math.sin(z * 15 + y * 6) + 0.04 * Math.cos(x * 13 + y * 5);
function makeSurface(N) {
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const lime = new THREE.Color(LIME), white = new THREE.Color("#e8ecd6");
  for (let i = 0; i < N; i++) {
    const cere = Math.random() < 0.12; let x, y, z, m;
    do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; m = x * x + y * y + z * z; } while (m > 1 || m < 0.02);
    const inv = 1 / Math.sqrt(m); x *= inv; y *= inv; z *= inv; const fd = fold(x, y, z);
    let px, py, pz;
    if (cere) { px = x * 0.4 * fd; py = -0.66 + y * 0.3 * fd; pz = -0.92 + z * 0.34 * fd; }
    else { const lobe = i % 2 ? 1 : -1; px = lobe * 0.42 + x * 0.55 * fd; py = y * 0.72 * fd; pz = z * 0.95 * fd; if (py < 0) py *= 0.82; }
    pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz;
    const c = Math.random() < 0.22 ? lime : white; col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  return { pos, col };
}
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
  const nodePos = new Float32Array(M * 3); nodes.forEach((n, i) => n.toArray(nodePos, i * 3));
  const linePos = new Float32Array(edges.length * 6); edges.forEach(([a, b], i) => { nodes[a].toArray(linePos, i * 6); nodes[b].toArray(linePos, i * 6 + 3); });
  return { nodes, edges, nodePos, linePos };
}
function Brain() {
  const group = useRef(), pulseRef = useRef(), sprite = useSprite();
  const surf = useMemo(() => makeSurface(2900), []);
  const net = useMemo(() => makeNet(66), []);
  const pulses = useRef(Array.from({ length: 13 }, () => ({ e: (Math.random() * net.edges.length) | 0, t: Math.random() })));
  useFrame((s, dt) => {
    if (group.current) group.current.rotation.y += dt * 0.04;
    const pp = pulseRef.current; if (!pp) return; const arr = pp.geometry.attributes.position.array;
    pulses.current.forEach((pl, i) => {
      pl.t += dt * 0.5; if (pl.t > 1) { pl.t = 0; pl.e = (Math.random() * net.edges.length) | 0; }
      const [a, b] = net.edges[pl.e];
      arr[i * 3] = net.nodes[a].x + (net.nodes[b].x - net.nodes[a].x) * pl.t;
      arr[i * 3 + 1] = net.nodes[a].y + (net.nodes[b].y - net.nodes[a].y) * pl.t;
      arr[i * 3 + 2] = net.nodes[a].z + (net.nodes[b].z - net.nodes[a].z) * pl.t;
    });
    pp.geometry.attributes.position.needsUpdate = true;
  });
  return (
    <group ref={group} scale={1.25}>
      <points>
        <bufferGeometry><bufferAttribute attach="attributes-position" args={[surf.pos, 3]} /><bufferAttribute attach="attributes-color" args={[surf.col, 3]} /></bufferGeometry>
        <pointsMaterial size={0.032} map={sprite} vertexColors transparent opacity={0.85} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
      </points>
      <lineSegments>
        <bufferGeometry><bufferAttribute attach="attributes-position" args={[net.linePos, 3]} /></bufferGeometry>
        <lineBasicMaterial color={LIME} transparent opacity={0.16} />
      </lineSegments>
      <points ref={pulseRef}>
        <bufferGeometry><bufferAttribute attach="attributes-position" args={[new Float32Array(pulses.current.length * 3), 3]} /></bufferGeometry>
        <pointsMaterial color="#ffffff" size={0.15} map={sprite} sizeAttenuation transparent depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
      </points>
    </group>
  );
}

/* ── a feature "planet": glass card with a per-feature visual ── */
const bar = (pos, w, h, color, key) => <mesh key={key} position={pos}><boxGeometry args={[w, h, 0.01]} /><meshBasicMaterial color={color} toneMapped={color === LIME} /></mesh>;
function CardInner({ k }) {
  if (k === "graph") {
    const pts = []; let y = -0.3; for (let i = 0; i < 12; i++) { y += Math.random() * 0.16 - 0.03; y = Math.max(-0.35, Math.min(0.38, y)); pts.push([-0.78 + (i / 11) * 1.56, y, 0.05]); }
    return <>{bar([-0.5, 0.46, 0.04], 0.7, 0.06, LIME, "h")}{bar([0, -0.4, 0.04], 1.6, 0.012, "#33363c", "b")}<Line points={pts} color={LIME} lineWidth={2} /></>;
  }
  if (k === "multi") return <>{bar([-0.4, 0.5, 0.04], 0.6, 0.07, LIME, "t")}<mesh position={[0.5, 0.5, 0.04]}><boxGeometry args={[0.42, 0.2, 0.01]} /><meshBasicMaterial color={LIME} toneMapped={false} /></mesh>{[0, 1, 2].map((i) => <group key={i} position={[0, 0.18 - i * 0.3, 0.04]}><mesh position={[-0.62, 0, 0]}><circleGeometry args={[0.05, 16]} /><meshBasicMaterial color={LIME} toneMapped={false} /></mesh>{bar([0, 0.05, 0], 0.9, 0.05, "#c4c7bd", "n")}{bar([-0.22, -0.07, 0], 0.46, 0.04, "#4a4d54", "o")}</group>)}</>;
  if (k === "gauge") return <>{bar([-0.5, 0.46, 0.04], 0.7, 0.06, LIME, "h")}{bar([0, 0, 0.04], 1.5, 0.16, "#23262b", "track")}{bar([-0.135, 0, 0.05], 1.23, 0.16, LIME, "fill")}{bar([0, -0.45, 0.04], 1.5, 0.012, "#33363c", "b")}</>;
  if (k === "scan") return <>{[[-0.7, 0.45], [0.7, 0.45], [-0.7, -0.45], [0.7, -0.45]].map(([x, y], i) => <group key={i}>{bar([x, y, 0.04], 0.34, 0.05, LIME, "a")}{bar([x + (x < 0 ? 0.145 : -0.145), y + (y < 0 ? 0.145 : -0.145), 0.04], 0.05, 0.34, LIME, "b")}</group>)}{bar([0, 0.08, 0.04], 0.5, 0.06, "#c4c7bd", "m1")}{bar([-0.12, -0.1, 0.04], 0.7, 0.05, "#4a4d54", "m2")}</>;
  // pricing — two columns
  return <>{bar([-0.42, 0.1, 0.04], 0.5, 0.55, "#23262b", "c1")}{bar([0.42, 0.16, 0.04], 0.5, 0.72, "#2f3a16", "c2")}{bar([0.42, 0.46, 0.05], 0.5, 0.1, LIME, "c2t")}{bar([-0.42, 0.1, 0.05], 0.28, 0.05, "#7a7d72", "p1")}{bar([0.42, 0.16, 0.05], 0.28, 0.05, LIME, "p2")}</>;
}
function FeaturePlanet({ f }) {
  const ref = useRef();
  useFrame((s) => { if (ref.current) ref.current.rotation.y = Math.sin(s.clock.elapsedTime * 0.3 + f.a) * 0.18 - d2r(f.a); });
  const w = f.k === "multi" ? 1.7 : 2, h = f.k === "multi" ? 1.5 : 1.3;
  return (
    <group position={planetPos(f)}>
      <Float speed={1} rotationIntensity={0.15} floatIntensity={0.5}>
        <group ref={ref}>
          <RoundedBox args={[w, h, 0.05]} radius={0.07} smoothness={4}><meshBasicMaterial color="#13151a" transparent opacity={0.62} /><Edges threshold={15} color={LIME} /></RoundedBox>
          <CardInner k={f.k} />
        </group>
      </Float>
    </group>
  );
}

/* ── scroll flies the camera through the orbital STATIONS ── */
const ease = (t) => t * t * (3 - 2 * t);
function OrbitalRig() {
  const scroll = useScroll(), pointer = usePointer(), { camera } = useThree();
  const tmp = useRef(new THREE.Vector3()), lookAt = useRef(new THREE.Vector3());
  useFrame(() => {
    const n = STATIONS.length, t = THREE.MathUtils.clamp(scroll.offset, 0, 1) * (n - 1);
    const i = Math.min(n - 2, Math.floor(t)), f = ease(t - i), A = STATIONS[i], B = STATIONS[i + 1];
    tmp.current.set(
      THREE.MathUtils.lerp(A.pos[0], B.pos[0], f) + pointer.current.x * 0.5,
      THREE.MathUtils.lerp(A.pos[1], B.pos[1], f) - pointer.current.y * 0.3,
      THREE.MathUtils.lerp(A.pos[2], B.pos[2], f)
    );
    camera.position.lerp(tmp.current, 0.07);
    lookAt.current.set(THREE.MathUtils.lerp(A.look[0], B.look[0], f), THREE.MathUtils.lerp(A.look[1], B.look[1], f), THREE.MathUtils.lerp(A.look[2], B.look[2], f));
    camera.lookAt(lookAt.current);
  });
  return null;
}

function Scene() {
  return (
    <>
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 10, 34]} />
      <Particles count={1400} />
      <Brain />
      {FEATURES.map((f) => <FeaturePlanet key={f.k} f={f} />)}
      <OrbitalRig />
      <EffectComposer disableNormalPass>
        <Bloom intensity={0.8} luminanceThreshold={0.2} luminanceSmoothing={0.9} mipmapBlur />
        <Vignette offset={0.3} darkness={0.8} />
      </EffectComposer>
    </>
  );
}

/* ── HTML, synced to scroll (one section per station) ── */
const badge = { display: "inline-block", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: LIME, border: `1px solid ${LIME}55`, borderRadius: 999, padding: "5px 12px", marginBottom: 20 };
const primaryBtn = { pointerEvents: "auto", background: LIME, color: "#0a0a0b", fontWeight: 700, fontSize: 14, border: "none", borderRadius: 12, padding: "13px 22px", cursor: "pointer" };
const ghostBtn = { pointerEvents: "auto", background: "rgba(10,10,11,0.5)", color: "#e9e9ec", fontWeight: 600, fontSize: 14, border: "1px solid #2a2a31", borderRadius: 12, padding: "13px 22px", cursor: "pointer" };
function Section({ children }) {
  return <section style={{ position: "relative", height: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 8vw", pointerEvents: "none" }}>{children}</section>;
}
function Overlay() {
  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", color: "#e9e9ec" }}>
      <div style={{ position: "absolute", inset: 0, height: "100%", pointerEvents: "none", background: "linear-gradient(100deg, rgba(10,10,11,0.92) 0%, rgba(10,10,11,0.5) 36%, rgba(10,10,11,0) 62%)" }} />
      <Section>
        <div style={{ maxWidth: 560 }}>
          <span style={badge}>AI Multi Builder</span>
          <h1 style={{ fontSize: "clamp(52px,9vw,116px)", lineHeight: 0.95, letterSpacing: "-0.04em", fontWeight: 700, margin: "0 0 18px" }}>Pickd<span style={{ color: LIME }}>.</span></h1>
          <p style={{ fontSize: "clamp(16px,2vw,21px)", lineHeight: 1.5, color: "#c2c2c9", maxWidth: 430, margin: "0 0 30px" }}>One AI brain. Every tool orbits it — tracker, multi builder, betslip OCR, the lot. Scroll to tour them.</p>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}><button style={primaryBtn}>Build a multi →</button><button style={ghostBtn}>See how it works</button></div>
        </div>
        <div style={{ position: "absolute", bottom: 34, left: "8vw", fontSize: 12, letterSpacing: "0.16em", textTransform: "uppercase", color: "#5f5f6a" }}>Scroll to orbit ↓</div>
      </Section>
      {FEATURES.map((f) => (
        <Section key={f.k}>
          <div style={{ maxWidth: 470 }}>
            <span style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: LIME }}>{f.tag}</span>
            <h2 style={{ fontSize: "clamp(30px,5vw,58px)", letterSpacing: "-0.03em", fontWeight: 700, margin: "12px 0 14px", whiteSpace: "pre-line", lineHeight: 1 }}>{f.title}<span style={{ color: LIME }}>.</span></h2>
            <p style={{ color: "#c2c2c9", fontSize: 17, lineHeight: 1.5, margin: "0 0 22px" }}>{f.body}</p>
            <div style={{ display: "flex", gap: 26, marginBottom: f.cta ? 26 : 0 }}>
              {f.stats.map(([l, v]) => (
                <div key={l}><div style={{ fontSize: 24, fontWeight: 700, color: "#fff" }}>{v}</div><div style={{ fontSize: 11.5, color: "#9a9aa4", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 2 }}>{l}</div></div>
              ))}
            </div>
            {f.cta ? <button style={primaryBtn}>{f.cta}</button> : null}
          </div>
        </Section>
      ))}
    </div>
  );
}

function Fallback2D() {
  return (
    <div style={{ position: "absolute", inset: 0, background: `radial-gradient(900px 500px at 70% 20%, ${LIME}14, transparent 60%), ${BG}`, color: "#e9e9ec", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 8vw" }}>
      <span style={badge}>AI Multi Builder</span>
      <h1 style={{ fontSize: "clamp(46px,13vw,84px)", lineHeight: 0.95, letterSpacing: "-0.04em", fontWeight: 700, margin: "0 0 16px" }}>Pickd<span style={{ color: LIME }}>.</span></h1>
      <p style={{ fontSize: 18, lineHeight: 1.5, color: "#c2c2c9", maxWidth: 520, margin: "0 0 28px" }}>MultiPick builds smarter AFL &amp; NBA multis — the safest legs, real edge, dialled to your target odds.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}><button style={primaryBtn}>Build a multi →</button><button style={ghostBtn}>See how it works</button></div>
      <div style={{ marginTop: 40, fontSize: 12, color: "#5f5f6a", letterSpacing: "0.06em" }}>2D fallback — the full WebGL experience loads on desktop.</div>
    </div>
  );
}
function PreviewBanner({ mode, setMode }) {
  const seg = (val, label) => <button onClick={() => setMode(val)} style={{ background: mode === val ? LIME : "transparent", color: mode === val ? "#0a0a0b" : "#9a9aa4", border: "none", borderRadius: 7, padding: "4px 11px", fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: "0.04em" }}>{label}</button>;
  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 16px", background: "rgba(10,10,11,0.7)", backdropFilter: "blur(10px)", borderBottom: "1px solid #1d1d25", pointerEvents: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#9a9aa4" }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: LIME, boxShadow: `0 0 8px ${LIME}` }} />
        Preview Mode · Pickd 3D landing <span style={{ color: "#5f5f6a" }}>(staging — not live)</span>
      </div>
      <div style={{ display: "flex", gap: 3, background: "rgba(255,255,255,0.04)", borderRadius: 9, padding: 3 }}>{seg("auto", "AUTO")}{seg("3d", "3D")}{seg("2d", "2D")}</div>
    </div>
  );
}
function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== "undefined" && (window.innerWidth < 820 || window.matchMedia("(prefers-reduced-motion: reduce)").matches));
  useEffect(() => { const f = () => setM(window.innerWidth < 820 || window.matchMedia("(prefers-reduced-motion: reduce)").matches); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  return m;
}
export default function Landing3D() {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState("auto");
  const show2D = mode === "2d" || (mode === "auto" && isMobile);
  return (
    <div style={{ position: "fixed", inset: 0, background: BG, overflow: "hidden" }}>
      <PreviewBanner mode={mode} setMode={setMode} />
      {show2D ? <Fallback2D /> : (
        <Canvas dpr={[1, 2]} camera={{ position: [0, 0.5, 7.9], fov: 45 }} gl={{ antialias: true, powerPreference: "high-performance" }} style={{ position: "absolute", inset: 0 }}>
          <Suspense fallback={null}>
            <ScrollControls pages={STATIONS.length} damping={0.28}>
              <Scene />
              <Scroll html style={{ width: "100%" }}><Overlay /></Scroll>
            </ScrollControls>
          </Suspense>
        </Canvas>
      )}
    </div>
  );
}
