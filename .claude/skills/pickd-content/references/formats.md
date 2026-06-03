# Pickd content formats — scaffolds, captions, posting

Build visual assets as **one self-contained HTML file** in `media/` (inline
CSS/JS, no build step). They're screen-record / screenshot targets. Always pull
colours, fonts and components from `brand-kit.md`. The repo-root files
`tiktok-launch-video.html` and `instagram-launch-post.html` are working
references — copy their structure.

---

## 1. Reel / TikTok (9:16, 1080×1920)

A 1080×1920 `.stage` scaled to fit the viewport, auto-playing through timed
scenes, looping, with **burned-in captions** (most people watch muted). Scenes
crossfade (opacity+transform, `cubic-bezier(.16,1,.3,1)`, ~.7s).

**Structure (promo reel):**
1. **Hook** (~4s) — a hook-bank line as giant text. No caption (the text *is* it).
2. **Logo** (~2.4s) — `Pickd.` + "The AI Multi Builder · AFL + NBA".
3. **Demo: click** (~2.9s) — controls mock (Sport/Target/Risk) + a JS-driven
   cursor that measures the real button position and clicks "Build multi"
   (button press + ripple). See `tiktok-launch-video.html` `runClickDemo()`.
4. **Demo: loading** (~2.6s) — the point-cloud sphere + "Building your multi" +
   cycling status (Reading form → De-vigging odds → Matchup → Optimising edge).
5. **Demo: reveal** (~3.2s) — multi card, legs cascade in (staggered).
6. **Every leg decoded** (~3.8s) — one leg big: Confidence / Cleared / Value /
   Recent avg tiles. (The differentiator — no tipster can show this.)
7. **Receipts** (~3.4s) — "It even shows its misses" + 83% strip.
8. **CTA** (~4.9s) — "3 free builds, every week" (lime) → founding badge →
   $4.99 ~~$6.99~~ forever → pickd.tech → compliance line.

Non-promo reels (form check / receipts / explainer) are shorter (5–6 scenes,
~16–20s): hook → 2–4 value beats → CTA. Drive scenes from a `STEPS` array of
`{key, cap, dur}` with a `setTimeout` chain + a top progress bar; loop with a
`Replay` button. Respect `prefers-reduced-motion` (render one frame).

**Always provide a VO script** timed to the scenes (one line per scene, read at
~2.5 words/sec). Aussie accent, medium energy.

---

## 2. Instagram carousel (4 slides, 1080×1080)

Slides are true 1080×1080 `<div>`s, previewed at ~0.5 scale with a "full size"
toggle for export. Screenshot each.

Default slide order:
1. **Hero** — `Pickd.` + tagline + a dot-sphere motif.
2. **MultiPick** — "Stop guessing your multis." + a multi card.
3. **Receipts** — "We show our misses." + 83% / 87% / ±4% strip + Well calibrated.
4. **CTA** — "3 free builds a week" → founding offer ($4.99 ~~$6.99~~ forever,
   X spots left) → pickd.tech → compliance line.

Each slide: `eyebrow` (10px uppercase, tracked), big headline (Inter Tight 800),
supporting line, lime accents on key words.

---

## 3. Story (9:16, 1080×1920)

Single message, big and thumb-stoppable. One idea per story. Leave the bottom
~250px clear for the link sticker / reply bar. Types: "we're live", countdown
("X founding spots left" — countdown sticker), prop poll ("this or that"),
behind-the-scenes of a build, reshare a comment/DM.

---

## 4. Captions + hashtags

**Instagram** — can run longer; use line breaks + emoji structure; put hashtags
in the **first comment** or at the very end. Always end with the compliance line.

Template:
```
[Hook line.]

[1–2 lines: what it does / the value.]

⚡ [benefit]
📊 [benefit]
🔍 [transparency benefit]

🔒 Founding offer: first 20 lock in Pro for A$4.99/week — forever.

Informational analysis only — not betting advice or a tipping service.
18+ · Gamble responsibly · Gambling Help 1800 858 858

👉 pickd.tech
```

IG hashtag set (first comment):
`#AFL #NBA #AFLfooty #aflstats #sportsanalytics #footy #datadriven #bettracker #multibuilder #aussiesport #nbaaustralia #pickd`

**TikTok** — short caption, 3–5 hashtags incl. `#fyp`:
```
[Hook.] 🎯 AI-built AFL multis, every leg graded. 3 free builds/wk → pickd.tech
Not tips. 18+ · gamble responsibly · 1800 858 858
#fyp #AFL #footy #sportsanalytics #nba
```

---

## 5. Content calendar

A 2-week markdown grid (or HTML if asked). Columns: **Day · Format · Pillar ·
Hook/Idea · Caption seed**. Reel-heavy (3–5/wk). Put value content (form check /
receipts / explainer) **Thu–Sat** around AFL rounds; promo/founding pushes on
slower days. Daily Stories underneath (poll / countdown / BTS). Lead the launch
week with the promo reel (pinned) + the carousel.

---

## 6. Bio (≤150 chars; emojis can count double — stay well under)

Three lines max. Must keep **"AFL + NBA"**, **"18+"**, and **"not tips / data"**.
Name field (separate, ~30 chars, searchable): `Pickd · AFL & NBA Multis`.

Example (~80 chars):
```
AI multi builder · AFL + NBA 🎯
Form-backed, every leg graded
3 free builds/wk · 18+ ⬇️
```

---

## 7. Posting note (append to every visual asset)

> **Record:** QuickTime → New Screen Recording → drag a tight box over the
> frame (reel loops once cleanly ~20s) / screenshot each carousel slide at full
> size. **Then:** add the VO + a *trending* sound in CapCut (do the sound
> in-app — it's the biggest reach lever). Cross-post the reel to IG Reels +
> TikTok; post the carousel to the IG grid.
