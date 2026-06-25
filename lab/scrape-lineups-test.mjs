// Parse-test for the lineup feed: extract named players per club from footywire's
// team-selections page (already curled to /tmp/fwt.html). Proves the feed works
// before we productionise the scraper + DB.
import { readFileSync } from "node:fs";
const html = readFileSync("/tmp/fwt.html", "utf8");

const byClub = new Map();
for (const m of html.matchAll(/pp-([a-z0-9-]+--[a-z0-9-]+)/g)) {
  const parts = m[1].split("--");
  const club = parts[0];
  const player = parts.slice(1).join("--").split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  if (!byClub.has(club)) byClub.set(club, new Set());
  byClub.get(club).add(player);
}

console.log(`clubs with a named team on the page: ${byClub.size}\n`);
for (const [club, players] of byClub) {
  console.log(`${club} — ${players.size} named`);
  console.log("  " + [...players].join(", ") + "\n");
}
