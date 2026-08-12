import fs from "fs";
import TorrentSearchAPI from "torrent-search-api";

const ENRICHED = "backend/data/enriched_400.json";
const OUT = process.argv[2] || "backend/data/nice-pick-sidecar.json";
const BAND = process.argv[3] || "nice"; // nice | must | ids:id1,id2

TorrentSearchAPI.enableProvider("ThePirateBay");
TorrentSearchAPI.enableProvider("Limetorrents");

function scoreContentVolume(title) {
  const lowerTitle = title.toLowerCase();
  if (/complete|full series|all seasons?|collection/i.test(lowerTitle)) return 1000;
  const multiSeasonMatch = lowerTitle.match(/s(\d+)-s(\d+)/);
  if (multiSeasonMatch) {
    return 500 + (parseInt(multiSeasonMatch[2]) - parseInt(multiSeasonMatch[1])) * 50;
  }
  if (/^(?!.*e\d{2}).*s\d{2}(?!-)/i.test(lowerTitle)) return 200;
  if (/e\d+-e\d+/i.test(lowerTitle)) return 150;
  if (/s\d{2}e\d{2}/i.test(lowerTitle)) return 10;
  return 800;
}
function isTvShaped(title) {
  const lower = title.toLowerCase();
  return (
    /complete|full series|all seasons?/i.test(lower) ||
    /s(\d+)-s(\d+)/.test(lower) ||
    /^(?!.*e\d{2}).*s\d{2}(?!-)/i.test(lower) ||
    /e\d+-e\d+/i.test(lower) ||
    /s\d{2}e\d{2}/i.test(lower)
  );
}
const BARE_EPISODE_PATTERN = /-\s?\d{1,3}\s?[[(]/;
function hasYearMismatch(title, year) {
  if (!year) return false;
  const years = title.match(/\b(19|20)\d{2}\b/g);
  if (!years) return false;
  return !years.some((y) => Math.abs(parseInt(y, 10) - year) <= 1);
}
const YEAR_RANGE_PATTERN = /\b(19|20)\d{2}\s*-\s*(19|20)\d{2}\b/;
const ADULT_CONTENT_PATTERN =
  /\b(xxx|milf|sexart|brazzers|reality kings|naughty america|bangbros|digital playground|vixen|blacked|tushy|metart|propertysex|twistys|wicked pictures|dorcel|jacquie et michel|nubile|teamskeet|mofos|babes\.com|femjoy|zero tolerance|erito|onlyfans|pornhub|interracial|kink|sexandsubmission|bdsm|hardcore|gangbang|anal|deepthroat|creampie|cumshot|stepsister|stepbrother|stepmom|porn|hentai)\b/i;

function isMismatchedMovieResult(title, contentType, year) {
  if (contentType !== "movie") return false;
  return (
    isTvShaped(title) ||
    BARE_EPISODE_PATTERN.test(title) ||
    YEAR_RANGE_PATTERN.test(title) ||
    hasYearMismatch(title, year)
  );
}

// Title must share significant tokens with catalog title (catches "Escape Room" for "Room")
function titleLooksRelated(resultTitle, catalogTitle) {
  const stop = new Set(["the", "a", "an", "of", "and", "or", "in", "on", "to", "for", "with"]);
  const tokens = catalogTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !stop.has(t));
  if (tokens.length === 0) return true;
  const rt = resultTitle.toLowerCase();
  // short titles (Her, F1, Room): require exact word boundary match of full title
  if (tokens.length <= 1 || catalogTitle.length <= 4) {
    const core = catalogTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (core.length <= 3) {
      // F1, etc. — require year already handled; need core as whole word-ish
      return new RegExp(`\\b${core}\\b`, "i").test(resultTitle) || rt.includes(core);
    }
  }
  const hits = tokens.filter((t) => rt.includes(t)).length;
  return hits >= Math.min(2, tokens.length) || hits / tokens.length >= 0.5;
}

const QUALITIES = [
  { label: "1080p", regex: /1080p/i, optionsKey: "torrent_options" },
  { label: "720p", regex: /720p/i, optionsKey: "torrent_options_720p" },
];
const SEARCH_RETRIES = 3;
const SEARCH_CONCURRENCY = 4;

async function findTorrentsForContent(title, qualityRegex, contentType, year, catalogTitle) {
  for (let attempt = 1; attempt <= SEARCH_RETRIES; attempt++) {
    try {
      const results = await TorrentSearchAPI.search(title, "All", 20);
      const topRaw = (results || [])
        .filter((t) => qualityRegex.test(t.title) && parseInt(t.seeds || 0) >= 5)
        .filter((t) => !ADULT_CONTENT_PATTERN.test(t.title))
        .filter((t) => !isMismatchedMovieResult(t.title, contentType, year))
        .filter((t) => titleLooksRelated(t.title, catalogTitle))
        .sort((a, b) => scoreContentVolume(b.title) - scoreContentVolume(a.title))
        .slice(0, 5);
      const candidates = [];
      for (const t of topRaw) {
        let magnet = t.magnet;
        if (!magnet) {
          try {
            magnet = await TorrentSearchAPI.getMagnet(t);
          } catch {
            continue;
          }
        }
        if (!magnet) continue;
        candidates.push({
          title: t.title,
          magnet,
          seeders: parseInt(t.seeds || 0),
          size: t.size,
          provider: t.provider,
          contentScore: scoreContentVolume(t.title),
        });
      }
      if (candidates.length > 0 || attempt === SEARCH_RETRIES) return candidates;
    } catch (error) {
      if (attempt === SEARCH_RETRIES) return [];
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  return [];
}

const data = JSON.parse(fs.readFileSync(ENRICHED, "utf-8"));
const triage = JSON.parse(fs.readFileSync("backend/data/acquisition-triage.json", "utf-8"));
const byId = new Map(data.items.map((i) => [i.id, i]));

let ids;
if (BAND.startsWith("ids:")) {
  ids = BAND.slice(4).split(",").filter(Boolean);
} else {
  ids = (triage[BAND] || []).map((r) => r.id);
}

// Only items that need pick
function needsPick(item) {
  if (!item) return false;
  const hasS3 = item.s3_key || (item.s3_keys && item.s3_keys.length) || item.hls_playlist_s3_key;
  if (hasS3) return false;
  const opts =
    (item.torrent_options || []).length + (item.torrent_options_720p || []).length;
  if (opts > 0 || item.torrent_file) return false;
  return true;
}

const targets = ids.map((id) => byId.get(id)).filter(needsPick);
console.log(`Band ${BAND}: ${ids.length} total, ${targets.length} need pick → ${OUT}\n`);

// Resume partial sidecar if present
let results = { generated_at: new Date().toISOString(), band: BAND, items: {} };
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf-8"));
    if (prev.items) results.items = prev.items;
  } catch {}
}

let next = 0;
async function worker() {
  while (true) {
    const i = next++;
    if (i >= targets.length) return;
    const item = targets[i];
    // skip if already in sidecar with options
    const existing = results.items[item.id];
    if (
      existing &&
      ((existing.torrent_options || []).length ||
        (existing.torrent_options_720p || []).length)
    ) {
      console.log(`[${i + 1}/${targets.length}] ${item.title} (already in sidecar)`);
      continue;
    }

    console.log(`[${i + 1}/${targets.length}] ${item.title} (${item.year})`);
    const entry = { id: item.id, title: item.title, year: item.year };
    for (const quality of QUALITIES) {
      // Prefer "Title Year" query for short/ambiguous titles
      const queries = [];
      const base = item.title;
      if (item.year) queries.push(`${base} ${item.year}`);
      queries.push(base);
      if (item.original_title && item.original_title !== item.title) {
        if (item.year) queries.push(`${item.original_title} ${item.year}`);
        queries.push(item.original_title);
      }

      let torrents = [];
      for (const q of queries) {
        torrents = await findTorrentsForContent(
          q,
          quality.regex,
          item.content_type,
          item.year,
          item.title,
        );
        if (torrents.length) {
          if (q !== base) console.log(`  ${quality.label}: via "${q}" → ${torrents.length}`);
          break;
        }
      }
      entry[quality.optionsKey] = torrents;
      if (torrents.length) {
        console.log(
          `  ${quality.label}: ✓ ${torrents.length} | ${torrents[0].title.slice(0, 70)}`,
        );
      } else {
        console.log(`  ${quality.label}: ⚠ none`);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    results.items[item.id] = entry;
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
}

await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, () => worker()));
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

let withAny = 0,
  empty = 0;
for (const e of Object.values(results.items)) {
  const n =
    (e.torrent_options || []).length + (e.torrent_options_720p || []).length;
  if (n) withAny++;
  else empty++;
}
console.log(`\nDone. sidecar items=${Object.keys(results.items).length} withOptions=${withAny} empty=${empty}`);
console.log(`Wrote ${OUT}`);
