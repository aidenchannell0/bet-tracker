// Pickd — DESKTOP landing. A fixed, orbiting star-dust canvas as the living backdrop;
// the real landing sections scroll OVER it, each data-card flying in from an angle, while
// scroll drives the camera's slow orbit. Heavy (Three.js) → lazy-loaded, desktop only.
// Phones get Landing2D.jsx (same sections, no WebGL). Shared markup lives in LandingSections.jsx.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import { useRef, useMemo, Suspense } from "react";
import * as THREE from "three";
import { LIME, BG, cta, PreviewBanner, LoginCorner, LandingContent } from "./LandingSections.jsx";

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

/* ── real anatomical brain (MIT model) re-skinned as a glowing lime wireframe. Currently
   toggled off in Scene (dust-only), but kept ready to drop back in. ── */
function Brain() {
  const group = useRef(), pulseRef = useRef(), sprite = useSprite();
  const { scene } = useGLTF("/brain.glb");
  const brain = useMemo(() => {
    const c = scene.clone(true);
    const box = new THREE.Box3().setFromObject(c), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const scale = 3.0 / (Math.max(size.x, size.y, size.z) || 1);
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
// NOTE: brain is currently toggled OFF in <Scene> (dust-only look), so we deliberately do
// NOT preload brain.glb — that would download ~2.6 MB on every desktop visit for nothing.
// If <Brain /> is re-enabled, useGLTF loads it on demand (or re-add useGLTF.preload here).

/* ── camera ORBITS as you scroll (scrollRef = page progress 0..1) ── */
function Rig({ scrollRef }) {
  const { camera } = useThree();
  useFrame((_, dt) => {
    const o = scrollRef.current || 0;                 // raw scroll; CSS snap keeps it smooth between sections
    const az = -0.45 + o * 3.3;                       // orbit ~190°
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

export default function Landing3D({ onStartFree, onLogin, staging = false }) {
  cta.startFree = onStartFree || (() => {});
  cta.login = onLogin || (() => {});
  const scrollRef = useRef(0);
  const rootRef = useRef(null);
  cta.explore = () => rootRef.current?.scrollBy({ top: window.innerHeight * 0.92, behavior: "smooth" });
  return (
    <div style={{ position: "fixed", inset: 0, background: BG, overflow: "hidden" }}>
      {staging ? <PreviewBanner which="3d" /> : <LoginCorner />}
      <div style={{ position: "fixed", inset: 0, zIndex: 0 }}>
        <Canvas dpr={[1, 2]} camera={{ position: [0, 0.5, 8.2], fov: 45 }} gl={{ antialias: true, powerPreference: "high-performance" }} onCreated={({ gl }) => { gl.localClippingEnabled = true; }}>
          <Suspense fallback={null}><Scene scrollRef={scrollRef} /></Suspense>
        </Canvas>
      </div>
      {/* symmetric side-scrim so headings stay readable over the dust */}
      <div style={{ position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none", background: "linear-gradient(90deg, rgba(10,10,11,0.62) 0%, rgba(10,10,11,0.12) 27%, rgba(10,10,11,0) 50%, rgba(10,10,11,0.12) 73%, rgba(10,10,11,0.62) 100%)" }} />
      <div ref={rootRef} onScroll={(e) => { const el = e.currentTarget; scrollRef.current = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight); }} style={{ position: "absolute", inset: 0, overflowY: "auto", overflowX: "hidden", zIndex: 2, scrollSnapType: "y mandatory" }}>
        <LandingContent scrollRoot={rootRef} />
      </div>
    </div>
  );
}
