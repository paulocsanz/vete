#!/usr/bin/env node
/**
 * Recover items that were fully downloaded locally by the old (now-retired)
 * local download-picked-torrents.js before it was migrated to caixote, but
 * never got transcoded/uploaded before the process was stopped - orphaned
 * under downloads/<id>/.
 *
 * These are all fresh (no existing s3_key), so per shouldEncryptItem() in
 * download-picked-torrents.js they take the same "greenfield encrypt" path:
 * transcode locally -> package HLS AES-128 -> upload segments, skipping the
 * plaintext progressive tier entirely (mirrors that script's own logic, and
 * reuses the same lib/hls-package.cjs the already-running
 * package-hls-from-s3.js uses).
 *
 * Discovery is dynamic (catalog id has no s3_key/hls_playlist_s3_key AND has
 * a downloads/<id>/ folder with video files), so this is safe to interrupt
 * and rerun - already-finished items are skipped, and each item's local
 * folder is only deleted after its catalog write succeeds.
 *
 * Usage:
 *   set -a && source .env.caixote && set +a
 *   node scripts/pipeline/upload-orphaned-downloads.mjs
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { transcodeForBrowser } from "./transcode.js";

const require = createRequire(import.meta.url);
const { parseCatalogKey } = require("../../lib/media-encryption.cjs");
const {
  recordHlsPackaged,
  applyHlsIndex,
  seedHlsIndexFromCatalog,
} = require("../../lib/hls-catalog-index.cjs");
const { packageHlsAes128 } = require("../../lib/hls-package.cjs");

const CATALOG_PATH =
  process.env.ENRICHED_DATA_PATH ||
  path.join("backend", "data", "enriched_400.json");
const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");
const VIDEO_EXTS = [".mp4", ".mkv", ".avi", ".mov", ".webm"];
const JUNK_VIDEO_PATTERN = /\bsample\b/i;

function loadBucketCreds() {
  const c = {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucketName: process.env.S3_BUCKET_NAME,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    urlStyle: process.env.S3_URL_STYLE || "virtual-host",
  };
  if (!c.accessKeyId || !c.secretAccessKey || !c.bucketName || !c.endpoint) {
    throw new Error("Missing S3_* env — source .env.caixote first");
  }
  return c;
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
}

function saveCatalog(catalog) {
  applyHlsIndex(catalog);
  const tmp = `${CATALOG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + "\n");
  fs.renameSync(tmp, CATALOG_PATH);
}

function makeS3(creds) {
  return new S3Client({
    region: creds.region,
    endpoint: creds.endpoint,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: creds.urlStyle === "path",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 30_000,
      requestTimeout: 600_000,
    }),
  });
}

async function uploadFile(client, bucket, key, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
      );
      return body.length;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

async function uploadMany(client, bucket, jobs, concurrency = 8) {
  let done = 0;
  const failed = [];
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      try {
        await uploadFile(client, bucket, job.key, job.filePath, job.contentType);
        done++;
        if (done % 25 === 0 || done === jobs.length) console.log(`  ↑ ${done}/${jobs.length}`);
      } catch {
        failed.push(job);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (failed.length > 0) {
    console.log(`  ↻ retrying ${failed.length}/${jobs.length} failed uploads…`);
    let rI = 0;
    async function retryWorker() {
      while (rI < failed.length) {
        const job = failed[rI++];
        await uploadFile(client, bucket, job.key, job.filePath, job.contentType);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, failed.length) }, retryWorker));
  }
}

// Best-effort sort key from filename patterns seen in this catalog:
// SxxExx, "1x20", "01x13", or a bare "301"/"309" prefix (season+2-digit-ep).
// Only used for relative ordering when some episodes are skipped as corrupt
// - exact season/episode identity isn't needed here, just a stable sequence.
function episodeSortKey(filename) {
  let m = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (m) return parseInt(m[1], 10) * 1000 + parseInt(m[2], 10);
  m = filename.match(/(\d{1,2})x(\d{1,3})/);
  if (m) return parseInt(m[1], 10) * 1000 + parseInt(m[2], 10);
  m = filename.match(/^(\d)(\d{2})\b/);
  if (m) return parseInt(m[1], 10) * 1000 + parseInt(m[2], 10);
  return null;
}

function isVideoFileHealthy(filePath) {
  try {
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

function getVideoFiles(dir) {
  const results = [];
  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (VIDEO_EXTS.some((e) => entry.name.toLowerCase().endsWith(e)) && !JUNK_VIDEO_PATTERN.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);

  const healthy = [];
  for (const f of results) {
    if (isVideoFileHealthy(f)) healthy.push(f);
    else console.log(`  ⚠ skipping corrupt file: ${path.basename(f)}`);
  }

  // Sort by parsed episode number when available (keeps relative order
  // correct even with gaps from skipped corrupt files); fall back to a
  // plain numeric filename sort for singles/unparseable names.
  return healthy.sort((a, b) => {
    const ka = episodeSortKey(path.basename(a));
    const kb = episodeSortKey(path.basename(b));
    if (ka !== null && kb !== null) return ka - kb;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function dirSizeBytes(dir) {
  let total = 0;
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  }
  try {
    walk(dir);
  } catch {}
  return total;
}

function findOrphanedItems(catalog) {
  const out = [];
  for (const item of catalog.items) {
    if (!item || item.s3_key || (item.s3_keys && item.s3_keys.length) || item.hls_playlist_s3_key) continue;
    const dir = path.join(DOWNLOADS_DIR, item.id);
    if (!fs.existsSync(dir)) continue;
    const files = getVideoFiles(dir);
    if (files.length === 0) continue;
    out.push({ item, dir, files, sizeBytes: dirSizeBytes(dir) });
  }
  out.sort((a, b) => a.sizeBytes - b.sizeBytes);
  return out;
}

async function packageOrphanedItem(client, creds, catalogKey, entry) {
  const { item, dir, files } = entry;
  const id = item.id;
  const multi = files.length > 1;
  console.log(`\n▶ ${item.title || id} (${id}) — ${files.length} source file(s), ${(entry.sizeBytes / 1e9).toFixed(2)} GB`);

  const tmpStat = fs.statfsSync(os.tmpdir());
  const freeGB = (tmpStat.bavail * tmpStat.bsize) / 1e9;
  if (freeGB < 5) throw new Error(`disk almost full (${freeGB.toFixed(1)} GB free in ${os.tmpdir()}) — skipping ${id}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-hls-"));
  let totalSegs = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const ep = i + 1;
      const label = multi ? `e${ep}` : "movie";
      const videoPath = files[i];

      console.log(`  ⚙ transcoding (${label}) from ${path.basename(videoPath)}…`);
      const normalizedPath = path.join(workDir, `${label}.mp4`);
      await transcodeForBrowser(videoPath, normalizedPath, { maxHeight: 720 });

      const hlsDir = path.join(workDir, `hls-${label}`);
      console.log(`  ⚙ ffmpeg HLS AES-128 (${label})…`);
      const { playlistPath, segmentFiles } = packageHlsAes128({
        inputPath: normalizedPath,
        outDir: hlsDir,
        catalogKey32: catalogKey,
        segmentSeconds: 4,
      });
      console.log(`  ✓ ${label}: ${segmentFiles.length} segments`);
      totalSegs += segmentFiles.length;

      const prefix = multi ? `videos/${id}/hls/e${ep}` : `videos/${id}/hls`;
      const jobs = segmentFiles.map((seg) => ({
        key: `${prefix}/${path.basename(seg)}`,
        filePath: seg,
        contentType: "video/mp2t",
      }));
      console.log(`  ↑ uploading ${jobs.length} segments (${label})…`);
      await uploadMany(client, creds.bucketName, jobs, 8);
      const playlistKey = `${prefix}/index.m3u8`;
      await uploadFile(client, creds.bucketName, playlistKey, playlistPath, "application/vnd.apple.mpegurl");
      console.log(`  ↑ ${playlistKey}`);

      fs.rmSync(hlsDir, { recursive: true, force: true });
      fs.rmSync(normalizedPath, { force: true });
    }

    const catalogHlsRef = multi ? `videos/${id}/hls` : `videos/${id}/hls/index.m3u8`;
    recordHlsPackaged(id, catalogHlsRef);
    const fresh = loadCatalog();
    const freshItem = fresh.items.find((x) => x && x.id === id);
    if (!freshItem) throw new Error(`catalog id vanished before save: ${id}`);
    freshItem.hls_playlist_s3_key = catalogHlsRef;
    freshItem.encrypted = true;
    saveCatalog(fresh);
    console.log(`✓ catalog: ${id} hls_playlist_s3_key=${catalogHlsRef}`);

    // Only reclaim disk after the catalog write actually succeeded.
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`🗑 removed ${dir}`);
    return { id, segments: totalSegs, episodes: files.length };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const catalogKey = parseCatalogKey(process.env.ENCRYPTION_CATALOG_KEY);
  if (!catalogKey) throw new Error("ENCRYPTION_CATALOG_KEY missing/invalid — source .env.caixote first");
  const creds = loadBucketCreds();
  const client = makeS3(creds);

  let catalog = loadCatalog();
  seedHlsIndexFromCatalog(catalog);
  const orphans = findOrphanedItems(catalog);
  console.log(`Found ${orphans.length} orphaned item(s) to recover (smallest first):`);
  orphans.forEach((o) => console.log(`  - ${o.item.id} (${(o.sizeBytes / 1e9).toFixed(2)} GB, ${o.files.length} file(s))`));

  let done = 0;
  let failed = 0;
  for (const entry of orphans) {
    try {
      await packageOrphanedItem(client, creds, catalogKey, entry);
      done++;
    } catch (e) {
      failed++;
      console.log(`✗ ${entry.item.id} failed: ${e.message}`);
    }
  }
  console.log(`\nDone. ${done} recovered, ${failed} failed.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
