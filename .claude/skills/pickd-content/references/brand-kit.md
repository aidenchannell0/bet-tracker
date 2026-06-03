# Pickd brand kit — tokens + component snippets

Everything visual should use these. Copy the snippets verbatim into the
standalone HTML assets so every reel/carousel/story looks consistent and matches
the live app (pickd.tech).

## Colour tokens

```css
:root{
  --bg:#0a0a0b;        /* near-black background */
  --surface:#131316;   /* card surface */
  --surface-2:#1a1a1f;
  --border:#232329; --border-s:#2f2f37;
  --text:#f5f5f7; --text-2:#a8a8b0; --text-3:#6b6b74;
  --accent:#cdfb50;    /* lime — the signature colour, use sparingly for punch */
  --positive:#4ade80;  /* green = hit / confidence */
  --warning:#f5b545; --danger:#ff5f4d;
}
```

## Type

- Display/UI: **Inter Tight** (weights 400–900). Wordmark + headlines use 800/900
  with tight letter-spacing (`-0.04em` to `-0.05em`).
- Numbers/odds/percentages: **JetBrains Mono** (class `.mono`).

```html
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
```

## The wordmark

Always `Pickd` + a lime full-stop. Never "Pickd" without the dot.

```html
<span class="bw">Pickd<span class="d">.</span></span>
<style>.bw{font-weight:900;letter-spacing:-.05em}.bw .d{color:var(--accent)}</style>
```

Pro lockup: `Pickd. <span style="color:var(--accent)">Pro</span>`.

## AFL guernsey crests (circular badges)

These are the *exact* stylised guernseys the app uses. Render as inline SVG with
`clip-path:circle(50%)` (no external logos → no copyright issue). Drop the white
ring `<circle r="15.2">` on each. Class `.crest` sets size (e.g. 54px) + `flex:none`.

```html
<!-- Collingwood (black, white stripes) -->
<svg class="crest" viewBox="0 0 32 32" style="clip-path:circle(50%)"><rect width="32" height="32" fill="#000"/><rect x="11" width="3" height="32" fill="#fff"/><rect x="18" width="3" height="32" fill="#fff"/><circle cx="16" cy="16" r="15.2" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/></svg>

<!-- Fremantle (purple, white chevrons) -->
<svg class="crest" viewBox="0 0 32 32" style="clip-path:circle(50%)"><rect width="32" height="32" fill="#2a0d54"/><polyline points="5,9 16,17 27,9" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/><polyline points="5,15 16,23 27,15" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="16" cy="16" r="15.2" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/></svg>

<!-- Western Bulldogs (red / white / blue bands) -->
<svg class="crest" viewBox="0 0 32 32" style="clip-path:circle(50%)"><rect width="32" height="32" fill="#e1251b"/><rect y="11" width="32" height="10" fill="#fff"/><rect y="21" width="32" height="11" fill="#0a4595"/><circle cx="16" cy="16" r="15.2" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/></svg>
```

More clubs (same `<rect>`/`<polyline>` pattern, then add the ring circle):
- **Adelaide**: navy `#002b5c`, red band `y=11 h=11 #e21937`, gold band `y=22 h=10 #ffd200`
- **Brisbane**: maroon `#7a002e`, navy band `#0c2340`, gold band `#fdbb30`
- **Carlton**: navy `#0e2547` + white ring `circle r=8 stroke #fff sw 1.6`
- **Essendon**: black + red sash `polygon 0,8 8,0 32,24 24,32 #cc2031`
- **Geelong**: white + 3 navy hoops `#022b5c` (y=3,13.25,23.5 h=5.5)
- **Hawthorn**: brown `#4d2004` + 3 gold stripes `#fbbf15` (x=6,14.25,22.5 w=3.5)
- **Melbourne**: navy `#0c1c3a` + red `polygon 0,32 32,32 16,10 #d6001c`
- **Port Adelaide**: black + white chevron + teal `#01b6c7` chevron
- **Richmond**: black + yellow sash `polygon 0,8 8,0 32,24 24,32 #ffd200`
- **Sydney**: white + red top-V `polygon 0,0 32,0 32,11 16,17 0,11 #ed171f`
- **West Coast**: navy `#06214f` left / gold `#f2a900` right (split at x=16)

For NBA teams use a simple two-stop gradient circle with the club colours, e.g.
`background:linear-gradient(135deg,#f58426,#1d428a)` (Knicks).

## Component: leg row (compact)

```html
<div class="leg"><!-- crest --><span class="nm">N. Daicos 25+ disposals</span><span class="cf mono">97%</span><span class="od mono">$1.20</span></div>
<style>
.leg{display:flex;align-items:center;gap:16px;padding:14px 0;border-top:1px solid var(--border)}
.leg:first-of-type{border-top:none}
.crest{width:54px;height:54px;flex:none}
.leg .nm{flex:1;font-size:30px;font-weight:600;color:var(--text)}
.leg .cf{font-size:30px;font-weight:700;color:var(--positive)}
.leg .od{font-size:30px;font-weight:700;width:120px;text-align:right;color:var(--text)}
</style>
```

## Component: multi card (header + legs)

```html
<div class="card">
  <div class="card-top"><span class="t">3-leg AFL multi</span><span class="o mono">$1.90</span></div>
  <!-- 3 .leg rows -->
</div>
<style>
.card{background:var(--surface);border:1px solid var(--border);border-radius:28px;padding:40px 44px}
.card-top{display:flex;justify-content:space-between;align-items:baseline}
.card-top .t{font-size:32px;font-weight:700}.card-top .o{font-size:46px;font-weight:800}
</style>
```

## Component: founding badge + price

```html
<div class="fbadge">🔒 First 20 lock in forever</div>
<div class="price-row"><span class="price-now bw">$4.99</span><span class="price-old mono">$6.99</span><span class="price-per">/ week, forever</span></div>
<style>
.fbadge{display:inline-flex;gap:12px;background:var(--accent);color:var(--bg);font-size:26px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;padding:16px 28px;border-radius:999px}
.price-row{display:flex;align-items:baseline;gap:24px;margin-top:40px}
.price-now{font-size:140px;font-weight:900;letter-spacing:-.05em;line-height:.9}
.price-old{font-size:56px;font-weight:600;color:var(--text-3);text-decoration:line-through}
.price-per{font-size:36px;color:var(--text-2)}
</style>
```

## Component: point-cloud sphere (the MultiPick "thinking" motif)

A rotating fibonacci point-cloud on canvas. Minimal, on-brand, eye-catching. Use
for "loading / AI working" moments.

```html
<canvas id="sphere" width="520" height="520"></canvas>
<script>
const cv=document.getElementById('sphere'),ctx=cv.getContext('2d');
const N=120,phi=Math.PI*(3-Math.sqrt(5)),P=[];
for(let i=0;i<N;i++){const y=1-(i/(N-1))*2,r=Math.sqrt(1-y*y),t=phi*i;P.push({x:Math.cos(t)*r,y,z:Math.sin(t)*r});}
let t0=performance.now();(function loop(now){const t=now-t0;ctx.clearRect(0,0,520,520);
  const cx=260,cy=260,R=190,ay=t*0.0005,ax=Math.sin(t*0.0006)*0.3;
  const pr=P.map(p=>{const c=Math.cos(ay),s=Math.sin(ay);let x=p.x*c-p.z*s,z=p.x*s+p.z*c,y=p.y;const cx2=Math.cos(ax),sx=Math.sin(ax);let y2=y*cx2-z*sx,z2=y*sx+z*cx2;const sc=3.2/(3.2-z2);return{sx:cx+x*R*sc,sy:cy+y2*R*sc,depth:(z2+1)/2,sc};}).sort((a,b)=>a.depth-b.depth);
  for(const p of pr){const lime=p.depth>0.8;ctx.fillStyle=lime?`rgba(205,251,80,${0.4+p.depth*0.6})`:`rgba(150,150,162,${0.16+p.depth*0.6})`;ctx.beginPath();ctx.arc(p.sx,p.sy,(0.9+2.4*p.depth)*p.sc,0,7);ctx.fill();}
  requestAnimationFrame(loop);})(performance.now());
</script>
```

(The live app's full version adds a glowing core + orbital rings + synapse
firing — keep that for the in-app build animation; the minimal version above is
better for social where it reads cleanly at small size.)

## Working reference files

The repo root already contains finished, working examples to copy structure
from — read these before building a new one:
- `tiktok-launch-video.html` — full 9:16 reel (timeline, demo sequence, captions)
- `instagram-launch-post.html` — 4-slide 1:1 carousel
- `multipick-loading-hybrid.html` — the full sphere animation
