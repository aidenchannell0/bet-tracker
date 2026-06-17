// Pickd — 3D landing PROTOTYPE (staging only, behind /preview).
// Zone 1 "Hero" built end-to-end: particle data-field, glowing grid-core, floating
// glass panels, scroll-driven camera, mouse parallax, bloom — plus a graceful 2D
// fallback and a Preview-Mode banner. Lazy-loaded so the live app never ships Three.js.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ScrollControls, Scroll, useScroll, Float, RoundedBox, Edges } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import { useRef, useMemo, useState, useEffect, Suspense } from "react";
import * as THREE from "three";

const LIME = "#d4f23a";
const BG = "#0a0a0b";

/* ── soft round sprite so particles glow instead of being hard squares ── */
function useSprite() {
  return useMemo(() => {
    const s = 64, c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }, []);
}

/* ── pointer position (normalised −0.5..0.5), shared by particles + camera ── */
function usePointer() {
  const p = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const f = (e) => { p.current.x = e.clientX / window.innerWidth - 0.5; p.current.y = e.clientY / window.innerHeight - 0.5; };
    window.addEventListener("pointermove", f, { passive: true });
    return () => window.removeEventListener("pointermove", f);
  }, []);
  return p;
}

/* ── the data-field: ~1500 drifting points, ~18% lime, mouse-parallaxed ── */
function Particles({ count = 1500 }) {
  const ref = useRef();
  const sprite = useSprite();
  const pointer = usePointer();
  const [positions, colors] = useMemo(() => {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    const lime = new THREE.Color(LIME), white = new THREE.Color("#cfd2c8"), grey = new THREE.Color("#5f5f68");
    for (let i = 0; i < count; i++) {
      const r = 5 + Math.random() * 11, th = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(th) * r * (0.55 + Math.random() * 0.7);
      pos[i * 3 + 1] = (Math.random() - 0.5) * 13;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 20 - 3;
      const c = Math.random() < 0.18 ? lime : Math.random() < 0.5 ? white : grey;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    return [pos, col];
  }, [count]);

  useFrame((_, dt) => {
    const g = ref.current; if (!g) return;
    g.rotation.y += dt * 0.018;
    g.rotation.x += (pointer.current.y * 0.22 - g.rotation.x) * 0.04;
    g.rotation.z += (pointer.current.x * 0.06 - g.rotation.z) * 0.04;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.085} map={sprite} vertexColors transparent opacity={0.92} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
}

/* ── grid-core orb: bright pulsing core inside a slow lime wireframe shell ── */
function CoreOrb() {
  const shell = useRef(), core = useRef();
  useFrame((s, dt) => {
    if (shell.current) { shell.current.rotation.y += dt * 0.15; shell.current.rotation.x += dt * 0.04; }
    if (core.current) core.current.scale.setScalar(1 + Math.sin(s.clock.elapsedTime * 1.6) * 0.07);
  });
  return (
    <group position={[0.2, 0.1, -3]}>
      <mesh ref={core}><sphereGeometry args={[0.42, 32, 32]} /><meshBasicMaterial color={LIME} toneMapped={false} /></mesh>
      <mesh ref={shell}><icosahedronGeometry args={[1.15, 1]} /><meshBasicMaterial color={LIME} wireframe transparent opacity={0.22} /></mesh>
    </group>
  );
}

/* ── a floating glass UI panel with lime edges + mini-dashboard accent bars ── */
function GlassPanel({ position, rotation = [0, 0, 0], scale = 1 }) {
  return (
    <Float speed={1.3} rotationIntensity={0.3} floatIntensity={0.7}>
      <group position={position} rotation={rotation} scale={scale}>
        <RoundedBox args={[2, 1.3, 0.05]} radius={0.07} smoothness={4}>
          <meshBasicMaterial color="#181a1f" transparent opacity={0.5} />
          <Edges threshold={15} color={LIME} />
        </RoundedBox>
        <mesh position={[-0.45, 0.3, 0.045]}><boxGeometry args={[0.7, 0.06, 0.01]} /><meshBasicMaterial color={LIME} toneMapped={false} /></mesh>
        <mesh position={[-0.25, 0.08, 0.045]}><boxGeometry args={[1.1, 0.05, 0.01]} /><meshBasicMaterial color="#3a3d44" /></mesh>
        <mesh position={[-0.4, -0.12, 0.045]}><boxGeometry args={[0.8, 0.05, 0.01]} /><meshBasicMaterial color="#3a3d44" /></mesh>
        <mesh position={[-0.15, -0.32, 0.045]}><boxGeometry args={[1.3, 0.05, 0.01]} /><meshBasicMaterial color="#2c2f35" /></mesh>
      </group>
    </Float>
  );
}

/* ── scroll- + mouse-driven camera: dolly in and descend toward zone 2 ── */
function Rig() {
  const scroll = useScroll();
  const pointer = usePointer();
  const { camera } = useThree();
  useFrame(() => {
    const o = scroll.offset; // 0..1 across the pages
    const tz = 8 - o * 5.2, ty = -o * 2.4;
    camera.position.x += (pointer.current.x * 0.9 - camera.position.x) * 0.05;
    camera.position.y += (ty - pointer.current.y * 0.5 - camera.position.y) * 0.05;
    camera.position.z += (tz - camera.position.z) * 0.05;
    camera.lookAt(0, ty * 0.5, -3);
  });
  return null;
}

function Scene() {
  return (
    <>
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 9, 30]} />
      <Particles count={1500} />
      <CoreOrb />
      <GlassPanel position={[3.3, 1.2, -1]} rotation={[0.1, -0.45, 0.05]} />
      <GlassPanel position={[-3.5, -0.4, 0]} rotation={[-0.06, 0.42, -0.04]} scale={0.86} />
      <GlassPanel position={[2.7, -1.9, 1]} rotation={[0.13, -0.5, 0.03]} scale={0.7} />
      <Rig />
      <EffectComposer disableNormalPass>
        <Bloom intensity={0.85} luminanceThreshold={0.2} luminanceSmoothing={0.9} mipmapBlur />
        <Vignette offset={0.3} darkness={0.78} />
      </EffectComposer>
    </>
  );
}

/* ── HTML that scrolls in sync with the 3D (drei <Scroll html>) ── */
const badge = { display: "inline-block", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: LIME, border: `1px solid ${LIME}55`, borderRadius: 999, padding: "5px 12px", marginBottom: 22 };
const primaryBtn = { pointerEvents: "auto", background: LIME, color: "#0a0a0b", fontWeight: 700, fontSize: 14, border: "none", borderRadius: 12, padding: "13px 22px", cursor: "pointer" };
const ghostBtn = { pointerEvents: "auto", background: "transparent", color: "#e9e9ec", fontWeight: 600, fontSize: 14, border: "1px solid #2a2a31", borderRadius: 12, padding: "13px 22px", cursor: "pointer" };

function Overlay() {
  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", color: "#e9e9ec" }}>
      <section style={{ height: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 8vw", pointerEvents: "none" }}>
        <div style={{ maxWidth: 700 }}>
          <span style={badge}>AI Multi Builder</span>
          <h1 style={{ fontSize: "clamp(52px,9vw,116px)", lineHeight: 0.95, letterSpacing: "-0.04em", fontWeight: 700, margin: "0 0 18px" }}>
            Pickd<span style={{ color: LIME }}>.</span>
          </h1>
          <p style={{ fontSize: "clamp(16px,2vw,21px)", lineHeight: 1.5, color: "#9a9aa4", maxWidth: 560, margin: "0 0 30px" }}>
            MultiPick builds smarter AFL &amp; NBA multis — the safest legs, real edge, dialled to your target odds.
          </p>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <button style={primaryBtn}>Build a multi →</button>
            <button style={ghostBtn}>See how it works</button>
          </div>
        </div>
        <div style={{ position: "absolute", bottom: 34, left: "8vw", fontSize: 12, letterSpacing: "0.16em", textTransform: "uppercase", color: "#5f5f6a" }}>Scroll to explore ↓</div>
      </section>

      <section style={{ height: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 8vw", pointerEvents: "none" }}>
        <h2 style={{ fontSize: "clamp(30px,5vw,56px)", letterSpacing: "-0.03em", fontWeight: 700, margin: "0 0 8px" }}>Three engines. One edge.</h2>
        <p style={{ color: "#9a9aa4", fontSize: 17, margin: "0 0 34px" }}>The full landing keeps scrolling through Features → Intelligence → Pricing → CTA.</p>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          {[["MultiPick", "AI multi builder"], ["Tracker", "ROI + history"], ["Risk engine", "odds + safety scoring"]].map(([t, d]) => (
            <div key={t} style={{ width: 210, padding: "20px 18px", borderRadius: 16, border: "1px solid #24242b", background: "rgba(16,16,20,0.55)", backdropFilter: "blur(8px)" }}>
              <div style={{ width: 8, height: 8, borderRadius: 999, background: LIME, marginBottom: 12 }} />
              <div style={{ fontSize: 17, fontWeight: 600 }}>{t}</div>
              <div style={{ fontSize: 13, color: "#9a9aa4", marginTop: 4 }}>{d}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ── graceful 2D fallback (mobile / reduced-motion / toggled) ── */
function Fallback2D() {
  return (
    <div style={{ position: "absolute", inset: 0, background: `radial-gradient(900px 500px at 70% 20%, ${LIME}14, transparent 60%), ${BG}`, color: "#e9e9ec", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 8vw" }}>
      <span style={badge}>AI Multi Builder</span>
      <h1 style={{ fontSize: "clamp(46px,13vw,84px)", lineHeight: 0.95, letterSpacing: "-0.04em", fontWeight: 700, margin: "0 0 16px" }}>Pickd<span style={{ color: LIME }}>.</span></h1>
      <p style={{ fontSize: 18, lineHeight: 1.5, color: "#9a9aa4", maxWidth: 520, margin: "0 0 28px" }}>MultiPick builds smarter AFL &amp; NBA multis — the safest legs, real edge, dialled to your target odds.</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button style={primaryBtn}>Build a multi →</button>
        <button style={ghostBtn}>See how it works</button>
      </div>
      <div style={{ marginTop: 40, fontSize: 12, color: "#5f5f6a", letterSpacing: "0.06em" }}>2D fallback — the full WebGL experience loads on desktop.</div>
    </div>
  );
}

/* ── staging banner + 3D/2D toggle ── */
function PreviewBanner({ mode, setMode }) {
  const seg = (val, label) => (
    <button onClick={() => setMode(val)} style={{ background: mode === val ? LIME : "transparent", color: mode === val ? "#0a0a0b" : "#9a9aa4", border: "none", borderRadius: 7, padding: "4px 11px", fontSize: 11, fontWeight: 700, cursor: "pointer", letterSpacing: "0.04em" }}>{label}</button>
  );
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
  useEffect(() => {
    const f = () => setM(window.innerWidth < 820 || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return m;
}

export default function Landing3D() {
  const isMobile = useIsMobile();
  const [mode, setMode] = useState("auto"); // auto | 3d | 2d
  const show2D = mode === "2d" || (mode === "auto" && isMobile);
  return (
    <div style={{ position: "fixed", inset: 0, background: BG, overflow: "hidden" }}>
      <PreviewBanner mode={mode} setMode={setMode} />
      {show2D ? (
        <Fallback2D />
      ) : (
        <Canvas dpr={[1, 2]} camera={{ position: [0, 0, 8], fov: 42 }} gl={{ antialias: true, powerPreference: "high-performance" }} style={{ position: "absolute", inset: 0 }}>
          <Suspense fallback={null}>
            <ScrollControls pages={2.6} damping={0.25}>
              <Scene />
              <Scroll html style={{ width: "100%" }}>
                <Overlay />
              </Scroll>
            </ScrollControls>
          </Suspense>
        </Canvas>
      )}
    </div>
  );
}
