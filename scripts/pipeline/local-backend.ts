/**
 * A local, disk-backed stand-in for the Cloudflare services the pipeline
 * normally talks to.
 *
 * Why this exists: `buildPipelineEnv()` wires D1 and KV over Cloudflare's
 * REST API against the real account ids in wrangler.toml. That is correct
 * for the GitHub Actions runner, and completely wrong for "show me the
 * pipeline working locally" — running it on a laptop would write scripts,
 * renders and exports straight into the production database and the
 * operator's live review queue.
 *
 * So `PIPELINE_LOCAL=1` swaps the backend, and nothing else. The stages
 * themselves — RESEARCH, SCRIPT, CRITIC, TTS, ALIGN, footage selection,
 * FFmpeg, EXPORT — are the exact same code paths a scheduled run takes.
 * The point of a local run is to exercise those, so substituting them
 * would defeat it.
 *
 * Everything lands under `.local-pipeline/`, which is gitignored.
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, type AppDb, type RawSqlClient } from "../../db/client.ts";
import { applyMigrations } from "../../db/apply-migrations.ts";
import type { KvLike } from "../../src/lib/drivers/cache-kv.ts";
import type { ExportBlobStore } from "../../src/server/console/exports.ts";
import type { DriverError, ExportDriver, ExportStoreRequest, ExportStoreResponse } from "../../src/lib/drivers/types.ts";
import { ok, type Result } from "../../src/lib/result.ts";

export const LOCAL_DIR = ".local-pipeline";
const KV_DIR = join(LOCAL_DIR, "kv");
const EXPORT_DIR = join(LOCAL_DIR, "exports");
/**
 * Overridable with PIPELINE_LOCAL_DB so a local run can write into the
 * database `wrangler dev` is already serving (miniflare keeps its D1 as a
 * plain SQLite file under .wrangler/state). Pointing both at one file is
 * what lets the operator console show a locally-rendered run.
 */
const DB_PATH = process.env.PIPELINE_LOCAL_DB ?? join(LOCAL_DIR, "pipeline.sqlite");

/** KV keys are opaque strings that can contain `/` and `:` — neither is safe as a filename. */
function kvPath(key: string): string {
  return join(KV_DIR, Buffer.from(key).toString("base64url"));
}

/**
 * Disk-backed KV. Values persist between runs, which matters: the
 * killswitch, the dispatch rate limit and the per-keyword montage cache
 * all live in KV, and a store that forgot them between invocations would
 * make the local run behave unlike the real one in exactly the places
 * those flags are load-bearing.
 */
export class LocalKv implements KvLike, ExportBlobStore {
  constructor() {
    mkdirSync(KV_DIR, { recursive: true });
  }

  get(key: string): Promise<string | null>;
  get(key: string, options: { type: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  get(key: string, options?: { type: "arrayBuffer" }): Promise<string | null | ArrayBuffer> {
    const path = kvPath(key);
    if (!existsSync(path)) return Promise.resolve(null);
    const buf = readFileSync(path);
    if (options?.type === "arrayBuffer") {
      return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    }
    return Promise.resolve(buf.toString("utf8"));
  }

  put(key: string, value: string): Promise<void> {
    // expirationTtl is accepted and ignored: nothing local expires, and a
    // fake TTL timer would be a behaviour the real KV does not have either
    // (KV expires server-side, not on the client).
    writeFileSync(kvPath(key), value, "utf8");
    return Promise.resolve();
  }

  putBlob(key: string, bytes: Uint8Array): void {
    writeFileSync(kvPath(key), bytes);
  }

  delete(key: string): Promise<void> {
    const path = kvPath(key);
    if (existsSync(path)) rmSync(path);
    return Promise.resolve();
  }
}

/**
 * Writes the finished MP4 to disk as well as to the local KV, so a local
 * run leaves something the operator can actually open and watch. Same
 * `ExportDriver` contract the KV driver implements, so `runExport` cannot
 * tell the difference — and the audit package still travels with it,
 * because `runExport` writes that to the database exactly as it always
 * does (CLAUDE.md NEVER block).
 */
export class LocalExportDriver implements ExportDriver {
  constructor(private readonly kv: LocalKv) {
    mkdirSync(EXPORT_DIR, { recursive: true });
  }

  store(req: ExportStoreRequest): Promise<Result<ExportStoreResponse, DriverError>> {
    this.kv.putBlob(req.key, req.bytes);
    // ttlSeconds is deliberately not honoured: KV expires values
    // server-side, and a local timer deleting the operator's file out from
    // under them would be a behaviour the real store does not have.
    writeFileSync(join(EXPORT_DIR, `${req.key.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.mp4$/, "")}.mp4`), req.bytes);
    return Promise.resolve(ok({ key: req.key, sizeBytes: req.bytes.byteLength }));
  }
}

export interface LocalBackend {
  db: AppDb;
  rawClient: RawSqlClient;
  hotKv: LocalKv;
  exportDriver: LocalExportDriver;
  dbPath: string;
}

/** Opens (creating and migrating on first use) the local pipeline database. */
export function openLocalBackend(): LocalBackend {
  mkdirSync(LOCAL_DIR, { recursive: true });
  // Only a database this harness created gets migrations applied to it. A
  // file handed in via PIPELINE_LOCAL_DB is someone else's (miniflare's),
  // and is migrated by whoever owns it — `wrangler d1 migrations apply`.
  const fresh = !existsSync(DB_PATH) && process.env.PIPELINE_LOCAL_DB === undefined;
  const { client, db } = createTestDb(DB_PATH);
  if (fresh) applyMigrations(client as unknown as Database.Database);
  const hotKv = new LocalKv();
  return { db, rawClient: client, hotKv, exportDriver: new LocalExportDriver(hotKv), dbPath: DB_PATH };
}
