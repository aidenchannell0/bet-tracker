// Pickd — MOBILE / reduced-motion landing. Identical sections to the desktop 3D landing,
// but the orbiting WebGL backdrop is replaced by a lightweight static CSS starfield + glow.
// No Three.js import here, so phones never download the heavy 3D bundle. Chosen by App for
// narrow viewports (and anyone who prefers reduced motion).
import { useRef } from "react";
import { LIME, BG, cta, PreviewBanner, LandingContent } from "./LandingSections.jsx";

// Three layered, tiled dot-fields at different sizes/offsets read as a calm starfield.
const STARS =
  "radial-gradient(1px 1px at 24px 36px, rgba(255,255,255,0.45), transparent)," +
  "radial-gradient(1px 1px at 130px 90px, rgba(212,242,58,0.40), transparent)," +
  "radial-gradient(1.4px 1.4px at 70px 160px, rgba(255,255,255,0.30), transparent)," +
  "radial-gradient(1px 1px at 180px 26px, rgba(207,210,200,0.35), transparent)," +
  "radial-gradient(1px 1px at 210px 140px, rgba(255,255,255,0.25), transparent)";

export default function Landing2D({ onStartFree, onLogin, staging = false }) {
  cta.startFree = onStartFree || (() => {});
  cta.login = onLogin || (() => {});
  const rootRef = useRef(null);
  cta.explore = () => rootRef.current?.scrollBy({ top: window.innerHeight * 0.92, behavior: "smooth" });
  return (
    <div style={{ position: "fixed", inset: 0, background: BG, overflow: "hidden" }}>
      {staging ? <PreviewBanner which="2d" /> : null}
      {/* static starfield */}
      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", backgroundColor: BG, backgroundImage: STARS, backgroundSize: "240px 240px" }} />
      {/* soft green glow up top to echo the 3D version's bloom */}
      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", background: `radial-gradient(620px 620px at 50% 14%, rgba(212,242,58,0.10), transparent 62%)` }} />
      <div ref={rootRef} style={{ position: "absolute", inset: 0, overflowY: "auto", overflowX: "hidden", zIndex: 2 }}>
        <LandingContent scrollRoot={rootRef} stacked />
      </div>
    </div>
  );
}
