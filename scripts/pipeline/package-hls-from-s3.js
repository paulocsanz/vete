#!/usr/bin/env node
/**
 * Download a catalog title from S3, package as HLS AES-128 VOD, upload under
 * videos/{id}/hls/, set hls_playlist_s3_key + encrypted=true on the catalog.
 *
 * Usage:
 *   set -a && source .env.caixote && set +a
 *   node scripts/pipeline/package-hls-from-s3.js --id the-matrix-1999-movie
 *   node scripts/pipeline/package-hls-from-s3.js --ids a,b,c
 *
 * Env: S3_* + ENCRYPTION_CATALOG_KEY (32-byte base64)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const require = createRequire(import.meta.url);
const {
  parseCatalogKey,
  decryptFile,
  isEncryptedFile,
} = require("../../lib/media-encryption.cjs");
const {
  recordHlsPackaged,
  applyHlsIndex,
  seedHlsIndexFromCatalog,
} = require("../../lib/hls-catalog-index.cjs");
const { packageHlsAes128 } = require("../../lib/hls-package.cjs");

const CATALOG_PATH =
  process.env.ENRICHED_DATA_PATH ||
  path.join("backend", "data", "enriched_400.json");

function parseArgs(argv) {
  const out = {
    ids: [],
    keepLocal: false,
    all: false,
    /** only single-file titles (default for --all) */
    singleOnly: true,
    limit: null,
    skipExisting: true,
    concurrency: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.ids.push(argv[++i]);
    else if (a === "--ids")
      out.ids.push(
        ...String(argv[++i])
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    else if (a === "--all") out.all = true;
    else if (a === "--include-series") out.singleOnly = false;
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--force") out.skipExisting = false;
    else if (a === "--keep-local") out.keepLocal = true;
    else if (a === "--concurrency") out.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

/** Source object keys for a title (episodes in order, or single movie). */
function sourceKeys(item) {
  if (item.s3_keys && item.s3_keys.length > 0) return [...item.s3_keys];
  if (item.s3_key) return [item.s3_key];
  return [];
}

/** Titles that still need HLS packaging. */
function pickPendingIds(catalog, { singleOnly, skipExisting, limit }) {
  const ids = [];
  for (const x of catalog.items) {
    if (!x) continue;
    const keys = sourceKeys(x);
    if (keys.length === 0) continue;
    if (skipExisting && x.hls_playlist_s3_key) continue;
    const multi = keys.length > 1;
    if (singleOnly && multi) continue;
    ids.push(x.id);
    if (limit && ids.length >= limit) break;
  }
  return ids;
}

/**
 * Download one S3 object, decrypt SSESENC1 if needed, return local media path.
 * Never loads the whole object into RAM (titles routinely exceed Node's 2 GiB
 * `fs.readFileSync` limit).
 */
async function materializePlain(client, bucket, s3Key, workDir, catalogKey, label) {
  const localIn = path.join(workDir, `${label}-source.bin`);
  await downloadToFile(client, bucket, s3Key, localIn);
  if (isEncryptedFile(localIn)) {
    console.log(`  🔓 ${label}: SSESENC1 → plaintext for packaging…`);
    const mediaPath = path.join(workDir, `${label}-plain.mp4`);
    const { plainBytes } = await decryptFile(localIn, mediaPath, catalogKey);
    console.log(`  🔓 ${label}: ${(plainBytes / 1e6).toFixed(1)} MB plain`);
    fs.rmSync(localIn, { force: true });
    return mediaPath;
  }
  return localIn;
}

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
  // Re-apply durable HLS index so concurrent pipeline saves can't drop flags
  // we already recorded (and so a partial write still heals siblings).
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

async function downloadToFile(client, bucket, key, dest) {
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  const total = head.ContentLength ?? 0;
  console.log(`  ↓ ${key} (${(total / 1e6).toFixed(1)} MB)`);

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    // Clean any partial file from previous attempt
    try { fs.rmSync(dest, { force: true }); } catch {}
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      // Explicitly handle stream errors that escape pipeline's Promise
      const streamErr = new Promise((_, reject) => {
        res.Body.on("error", reject);
      });
      await Promise.race([
        pipeline(res.Body, createWriteStream(dest)),
        streamErr,
      ]);
      res.Body.removeAllListeners("error");
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        console.log(`  ↻ download retry ${attempt + 1}/3 (${e.message})…`);
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

async function uploadFile(client, bucket, key, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return body.length;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/** Upload many objects with bounded concurrency, resilient to transient failures. */
async function uploadMany(client, bucket, jobs, concurrency = 8) {
  let done = 0;
  const failed = [];
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const idx = i++;
      const job = jobs[idx];
      try {
        await uploadFile(client, bucket, job.key, job.filePath, job.contentType);
        done++;
        if (done % 25 === 0 || done === jobs.length) {
          console.log(`  ↑ ${done}/${jobs.length}`);
        }
      } catch (e) {
        failed.push(job);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );

  // Second pass: retry failed jobs with lower concurrency
  if (failed.length > 0) {
    console.log(`  ↻ retrying ${failed.length}/${jobs.length} failed uploads…`);
    let rDone = 0;
    let rI = 0;
    async function retryWorker() {
      while (rI < failed.length) {
        const idx = rI++;
        const job = failed[idx];
        await uploadFile(client, bucket, job.key, job.filePath, job.contentType);
        rDone++;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(4, failed.length) }, () => retryWorker()),
    );
    done += failed.length;
    console.log(`  ↑ ${done}/${jobs.length} (after retry)`);
  }
}

/**
 * Package one catalog title.
 * - Movie / single file → videos/{id}/hls/index.m3u8
 * - Series (s3_keys) → videos/{id}/hls/e{1..N}/index.m3u8 + catalog
 *   hls_playlist_s3_key = videos/{id}/hls (prefix for playlist API)
 */
async function packageOne(client, creds, catalog, catalogKey, id, opts) {
  const item = catalog.items.find((x) => x && x.id === id);
  if (!item) throw new Error(`catalog id not found: ${id}`);
  const keys = sourceKeys(item);
  if (keys.length === 0) throw new Error(`${id}: no s3_key/s3_keys`);

  // Disk-space guard: bail early with a clear message if temp disk is nearly full.
  try {
    const tmpStat = fs.statfsSync(os.tmpdir());
    const freeGB = (tmpStat.bavail * tmpStat.bsize) / 1e9;
    if (freeGB < 5) {
      throw new Error(
        `disk almost full (${freeGB.toFixed(1)} GB free in ${os.tmpdir()}) — skipping ${id}`,
      );
    }
  } catch (checkErr) {
    if (checkErr.message.includes("disk almost full")) throw checkErr;
    // statfsSync might not exist on all platforms — skip guard silently
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "hls-"));
  const multi = keys.length > 1;
  console.log(
    `\n▶ HLS-AES package ${item.title || id} (${id}) — ${keys.length} source(s)`,
  );

  let totalSegs = 0;
  try {
    for (let i = 0; i < keys.length; i++) {
      const ep = i + 1; // 1-based episode index for API
      const label = multi ? `e${ep}` : "movie";
      const mediaPath = await materializePlain(
        client,
        creds.bucketName,
        keys[i],
        workDir,
        catalogKey,
        label,
      );
      const hlsDir = path.join(workDir, `hls-${label}`);
      console.log(`  ⚙ ffmpeg HLS AES-128 (${label})…`);
      const { playlistPath, segmentFiles } = packageHlsAes128({
        inputPath: mediaPath,
        outDir: hlsDir,
        catalogKey32: catalogKey,
        segmentSeconds: 4,
      });
      console.log(`  ✓ ${label}: ${segmentFiles.length} segments`);
      totalSegs += segmentFiles.length;

      const prefix = multi
        ? `videos/${id}/hls/e${ep}`
        : `videos/${id}/hls`;
      const jobs = segmentFiles.map((seg) => ({
        key: `${prefix}/${path.basename(seg)}`,
        filePath: seg,
        contentType: "video/mp2t",
      }));
      console.log(`  ↑ uploading ${jobs.length} segments (${label})…`);
      await uploadMany(client, creds.bucketName, jobs, 8);
      const playlistKey = `${prefix}/index.m3u8`;
      await uploadFile(
        client,
        creds.bucketName,
        playlistKey,
        playlistPath,
        "application/vnd.apple.mpegurl",
      );
      console.log(`  ↑ ${playlistKey}`);
      // free disk between episodes
      fs.rmSync(hlsDir, { recursive: true, force: true });
      try {
        fs.rmSync(mediaPath, { force: true });
      } catch {
        /* ignore */
      }
    }

    // Catalog: full playlist key for movies; prefix for multi-ep series.
    const catalogHlsRef = multi
      ? `videos/${id}/hls`
      : `videos/${id}/hls/index.m3u8`;

    // Durable sidecar first — survives download-picked full-catalog rewrites.
    recordHlsPackaged(id, catalogHlsRef);
    const fresh = loadCatalog();
    const freshItem = fresh.items.find((x) => x && x.id === id);
    if (!freshItem) throw new Error(`catalog id vanished before save: ${id}`);
    freshItem.hls_playlist_s3_key = catalogHlsRef;
    freshItem.encrypted = true;
    // Delivery is HLS-only going forward (no SSESENC1 progressive flag needed).
    saveCatalog(fresh);
    item.hls_playlist_s3_key = catalogHlsRef;
    item.encrypted = true;
    console.log(`\n✓ catalog: ${id} hls_playlist_s3_key=${catalogHlsRef}`);
    return { id, playlistKey: catalogHlsRef, segments: totalSegs, episodes: keys.length };
  } finally {
    if (!opts.keepLocal) {
      fs.rmSync(workDir, { recursive: true, force: true });
    } else {
      console.log(`  kept ${workDir}`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.all && opts.ids.length === 0)) {
    console.log(`Usage:
  node scripts/pipeline/package-hls-from-s3.js --id <catalog-id>
  node scripts/pipeline/package-hls-from-s3.js --ids id1,id2
  node scripts/pipeline/package-hls-from-s3.js --all [--limit N] [--include-series] [--force] [--concurrency N]
  (default --all = single-file only; --include-series packages multi-ep as e1..eN)
Env: S3_* ENCRYPTION_CATALOG_KEY`);
    process.exit(opts.help ? 0 : 1);
  }

  const catalogKey = parseCatalogKey(process.env.ENCRYPTION_CATALOG_KEY);
  if (!catalogKey) throw new Error("ENCRYPTION_CATALOG_KEY missing/invalid");
  const creds = loadBucketCreds();
  const client = makeS3(creds);
  let catalog = loadCatalog();
  // Bootstrap durable index from any HLS flags already on disk / in git checkout.
  const seeded = seedHlsIndexFromCatalog(catalog);
  if (seeded.added > 0) {
    console.log(`── hls index: seeded ${seeded.added} title(s) from catalog`);
  }

  if (opts.all) {
    opts.ids = pickPendingIds(catalog, opts);
    console.log(
      `── --all: ${opts.ids.length} title(s) pending HLS` +
        (opts.limit ? ` (limit ${opts.limit})` : ""),
    );
  }

  // --- concurrent packaging pool ---
  // Catalog saves are concurrency-safe: recordHlsPackaged() writes to a durable
  // sidecar synchronously, and saveCatalog() calls applyHlsIndex() before every
  // write, re-applying ALL sidecar flags. Even if two workers race on
  // load-modify-save, the last writer's applyHlsIndex heals every flag.
  const concurrency = Math.min(opts.concurrency, opts.ids.length);
  const results = [];
  let nextIdx = 0;

  async function poolWorker(workerNum) {
    while (nextIdx < opts.ids.length) {
      const myIdx = nextIdx++;
      const id = opts.ids[myIdx];
      try {
        if (opts.skipExisting) {
          const cur = loadCatalog().items.find((x) => x && x.id === id);
          if (cur?.hls_playlist_s3_key) {
            console.log(`skip ${id} (already has HLS)`);
            results.push({ id, skipped: true });
            continue;
          }
        }
        const res = await packageOne(client, creds, loadCatalog(), catalogKey, id, opts);
        results.push(res);
        console.log(
          `  [worker ${workerNum}] done: ${id} (${res.segments} segs) — ` +
            `${results.filter((r) => !r.error && !r.skipped).length}/${opts.ids.length} complete`,
        );
      } catch (e) {
        console.error(`FAIL ${id}:`, e?.message || e);
        console.error(`  ${e?.stack || e}`);
        if (e?.Code || e?.name) console.error(`  name=${e?.name} code=${e?.Code}`);
        results.push({ id, error: String(e?.message || e) });
      }
    }
  }

  if (concurrency > 1) {
    console.log(`── concurrent pool: ${concurrency} workers, ${opts.ids.length} title(s)`);
    await Promise.all(
      Array.from({ length: concurrency }, (_, i) => poolWorker(i + 1)),
    );
  } else {
    await poolWorker(1);
  }
  console.log("\n── summary ──");
  let ok = 0,
    fail = 0,
    skip = 0;
  for (const r of results) {
    if (r.error) {
      fail++;
      console.log(`  fail ${r.id}: ${r.error}`);
    } else if (r.skipped) {
      skip++;
    } else {
      ok++;
      console.log(`  ok   ${r.id} → ${r.playlistKey} (${r.segments} segs)`);
    }
  }
  console.log(`  totals: ok=${ok} fail=${fail} skip=${skip}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
