---
name: pickd-content
description: >-
  Generate on-brand social media content for Pickd (pickd.tech) — the AI multi
  builder + bet tracker for AFL and NBA. Use this whenever the user wants a
  TikTok/Reel, an Instagram post or carousel, a Story, a caption, hashtags, a
  content calendar, a bio, or any marketing copy/visual for Pickd. Trigger on
  phrases like "make a Pickd reel", "write a caption", "instagram post",
  "tiktok video", "content calendar", "promo for the founding offer", or any
  request to promote MultiPick / the app — even if they don't say "Pickd"
  explicitly but are clearly working on this project's marketing. Produces
  record-ready animated HTML (9:16 reels, 1:1 carousels, 9:16 stories) plus
  platform-tuned captions and hashtags, always keeping the brand voice and the
  gambling-compliance guardrails.
---

# Pickd content generator

You create launch-quality social content for **Pickd** — an AI sports-multi
builder + bet tracker. The job is to turn a short request ("a receipts reel",
"founding-offer carousel", "caption for a form-check post") into finished,
on-brand, compliance-safe assets the user can post.

Two things make this skill valuable, so protect them:
1. **Brand + visual consistency** — every asset looks like it came from the same
   studio (the dark editorial look, the lime accent, the `Pickd.` wordmark, the
   real guernsey badges). Pull the exact tokens and component snippets from
   `references/brand-kit.md` rather than reinventing them each time.
2. **Compliance** — Pickd is an *analysis tool*, not a tipping service. Get this
   wrong and the user's ad accounts get banned. The rules below are
   non-negotiable.

## How to respond to a request

1. Identify the **format** (reel / carousel / story / caption-only / calendar /
   bio) and the **pillar** (promo, form check, receipts, explainer, timely
   reaction, founder/BTS — see Content pillars).
2. For visual formats, build a **self-contained animated HTML file** in
   `media/` (create the folder if needed) using the scaffolds + components in
   `references/formats.md` and `references/brand-kit.md`. These are screen-record
   targets, not production code — one file, inline CSS/JS, no build step.
3. Always include the matching **caption + hashtags** (platform-tuned) and a
   one-line **how-to-record/post** note.
4. Open the file with `open <path>` so the user can see it immediately.
5. Keep the compliance line on the asset *and* in the caption.

Default to doing the obvious thing well rather than asking lots of questions. If
the request is genuinely ambiguous (e.g. "make a post" with no angle), pick the
strongest pillar for where they are (launch → promo or founding offer) and say
why.

## The brand voice

Confident, sharp, a little cheeky — never hypey "sports-betting-ad" energy.
Talks *with* the viewer, never down to them. The through-line is **data and
honesty**: we model the game like the bookies do, and we show our misses.

- **Do:** short punchy lines, concrete numbers, the shared-enemy angle ("your
  bookie has a data science team — now you've got one too"), curiosity, dry
  Aussie wit.
- **Don't:** make the viewer feel stupid ("you're betting wrong"), promise
  winnings, hype ("GUARANTEED BANKER 🔥"), or sound like a tipster.

Hooks decide everything on TikTok/Reels (first 1–2s). There's a vetted hook bank
below — prefer those shapes.

## Non-negotiable facts (keep these accurate)

- **Product:** Pickd — AI **multi builder ("MultiPick")** + **bet tracker**. AFL
  and NBA. Builds **form-backed multis** to a target odds, with a **confidence
  score on every leg**, **+EV / value vs market**, correlation-aware combined
  odds, and a public **calibration / track record** ("we show our misses").
- **Free tier:** **3 free builds every week** (no card needed).
- **Founding offer:** the **first 20 subscribers** lock in Pro at **A$4.99/week
  — forever** (normally **A$6.99/week**). Frame "forever" prominently.
- **URL:** **pickd.tech**
- **Sports examples:** use **real AFL players** with believable lines (e.g.
  *N. Daicos 25+ disposals*, *C. Serong 25+ disposals*, *M. Bontempelli 20+
  disposals*). Disposals/goals/marks/tackles for AFL; points/rebounds/assists
  for NBA. Numbers are **illustrative** — never claim a specific bet will win.

## Compliance guardrails (do not break)

Pickd is **informational analysis, not betting advice or a tipping service**.
Meta/TikTok restrict gambling promotion hard; staying on the "data tool" side is
both the brand and the shield.

Every public asset (visual + caption) must:
- Carry **"18+ · Gamble responsibly"** and the helpline **"Gambling Help 1800
  858 858"** (AU). On reels/carousels put it on the final/CTA frame; in captions
  put it near the end.
- Include framing like **"informational analysis only — not betting advice or a
  tipping service"** (or the shorter "not tips, just data").

Never:
- Promise or imply winnings, "locks", or guaranteed outcomes.
- Show "winning betslip" screenshots or ROI-as-a-promise.
- Use urgency that pressures gambling ("bet now before…"). Urgency is fine for
  the *subscription* offer ("first 20 spots"), not for betting.

## Content pillars (pick one per asset)

- **Promo** — what Pickd is / the launch. (Hero asset.)
- **Form check** — "3 in-form AFL mids this round" (data flex; great reach).
- **Receipts** — "we rated this 80%, here's what happened" / "83% over 120
  picks" (transparency = the moat).
- **Explainer** — "why your SGM pays less than it shows", "what de-vigging is",
  "what 'confidence' means" (educational, builds authority).
- **Timely reaction** — team news, a star's hot streak, pre-round (ride the AFL
  news cycle; post Thu–Sat).
- **Founder / BTS** — "why I built Pickd" (authenticity → trust).

80/20: mostly value (form check / receipts / explainer), sparingly promo.

## Hook bank (shared-enemy + curiosity > everything)

- "Your bookie has a data science team. Now you've got one too." *(flagship)*
- "The bookies aren't guessing — now you don't have to either."
- "Your bookie has a data team. Now you do too."
- "I built an AI to build my AFL multis."
- "What if every leg came with a confidence score?"
- "An app that actually shows you when it's wrong."
- "Your same-game multi is lying to you about its odds." *(explainer)*
- "POV: your multi finally has real data behind it."

Avoid "beat the bookies" / "take their edge" — implies winning (compliance risk).

## Output formats

Detailed scaffolds, the animated-HTML structure, the reusable components (leg
card, guernsey crests, point-cloud sphere, founding badge), and the full caption
+ hashtag library live in:

- **`references/brand-kit.md`** — colours, fonts, CSS tokens, and copy-paste HTML
  component snippets (crests, cards, sphere, badges). Read this for any visual.
- **`references/formats.md`** — per-format build scaffolds (9:16 reel timeline,
  1:1 carousel, 9:16 story), caption/hashtag patterns per platform, and the
  posting-notes template. Read this when building any asset.

Quick shape of each:
- **Reel / TikTok (9:16, 1080×1920):** auto-playing, looping, timed scenes with
  burned-in captions; hook in scene 1; demo (cursor → build → sphere → reveal)
  for promo; CTA with 3-free-builds + founding offer. Screen-record target.
- **Instagram carousel (4 slides, 1080×1080):** hero → MultiPick → receipts →
  CTA. Screenshot each slide.
- **Story (9:16):** single message + sticker prompt (poll / countdown / link).
- **Caption-only:** IG (longer, line breaks, hashtags in first comment) vs
  TikTok (short, #fyp + 3–4 tags). Both carry the compliance line.
- **Calendar:** 2-week grid — format / pillar / hook / caption seed per day,
  Reel-heavy, value content Thu–Sat around AFL rounds.
- **Bio:** ≤150 chars (emojis can count double — stay well under), must keep
  "AFL + NBA", "18+", and "not tips / data".

## After producing an asset

- Open it (`open <path>`).
- Give the caption + hashtags as copy-paste blocks.
- Add the one-line record/post note (e.g. "QuickTime → New Screen Recording →
  drag a box; add VO + a trending sound in CapCut").
- If it's a reel, include a short **VO script** timed to the scenes.
