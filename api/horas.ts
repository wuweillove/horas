import type { Context } from "hono";
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";

const ROOT = "/home/workspace/horas/vaults";
const HEX = /^[a-f0-9]{20}$/;
const MAX_BYTES = 1_000_000;
const MAX_SNAPS = 60;

type Job = { id: string; name: string };
type Entry = {
  id: string;
  clockIn: number;
  clockOut: number | null;
  comment: string;
  origin?: string;
  jobId?: string;
};
type Store = {
  version: 2;
  jobs: Job[];
  activeJobId: string;
  entries: Entry[];
  vaultId: string;
  savedAt: number;
  deletedIds: string[];
};

function vaultOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
  return HEX.test(id) ? id : null;
}

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<Job>;
  return typeof job.id === "string" && typeof job.name === "string" && job.name.trim() !== "";
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Entry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.clockIn === "number" &&
    (entry.clockOut === null || typeof entry.clockOut === "number") &&
    typeof entry.comment === "string"
  );
}

function asStore(data: unknown, vaultId: string): Store | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Partial<Store> & { entries?: unknown; jobs?: unknown; deletedIds?: unknown };
  if (!Array.isArray(value.entries)) return null;
  const jobs = Array.isArray(value.jobs) ? value.jobs.filter(isJob) : [];
  const deletedIds = Array.isArray(value.deletedIds)
    ? [...new Set(value.deletedIds.filter((id): id is string => typeof id === "string"))]
    : [];
  const deleted = new Set(deletedIds);
  const liveJobs = jobs.filter((job) => !deleted.has(job.id));
  const sealedJobs = liveJobs.length > 0 ? liveJobs : [{ id: "job-1", name: "Trabajo 1" }];
  const fallback = sealedJobs[0].id;
  const entries = value.entries.filter(isEntry).filter((entry) => !deleted.has(entry.id));
  const savedAt = typeof value.savedAt === "number" && Number.isFinite(value.savedAt) ? value.savedAt : 0;
  const activeJobId = sealedJobs.some((job) => job.id === value.activeJobId) ? (value.activeJobId as string) : fallback;
  return {
    version: 2,
    jobs: sealedJobs,
    activeJobId,
    entries,
    vaultId,
    savedAt,
    deletedIds,
  };
}

function merge(left: Store, right: Store, vaultId: string): Store {
  const primary = right.savedAt >= left.savedAt ? right : left;
  const secondary = primary === right ? left : right;
  const liveIds = new Set([...primary.entries.map((entry) => entry.id), ...primary.jobs.map((job) => job.id)]);
  const deleted = new Set(primary.deletedIds);
  for (const id of secondary.deletedIds) {
    if (!liveIds.has(id)) deleted.add(id);
  }
  const jobs = new Map<string, Job>();
  for (const job of [...secondary.jobs, ...primary.jobs]) {
    if (!deleted.has(job.id)) jobs.set(job.id, job);
  }
  const entries = new Map<string, Entry>();
  for (const entry of [...secondary.entries, ...primary.entries]) {
    if (!deleted.has(entry.id)) entries.set(entry.id, entry);
  }
  const jobList = [...jobs.values()];
  const sealedJobs = jobList.length > 0 ? jobList : [{ id: "job-1", name: "Trabajo 1" }];
  const fallback = sealedJobs[0].id;
  return {
    version: 2,
    jobs: sealedJobs,
    activeJobId: sealedJobs.some((job) => job.id === primary.activeJobId) ? primary.activeJobId : fallback,
    entries: [...entries.values()],
    vaultId,
    savedAt: Math.max(left.savedAt, right.savedAt, Date.now()),
    deletedIds: [...deleted],
  };
}

async function prune(dir: string): Promise<void> {
  const files = (await readdir(dir)).filter((name) => name.startsWith("snap-") && name.endsWith(".json")).sort();
  while (files.length > MAX_SNAPS) {
    const oldest = files.shift();
    if (oldest) await unlink(join(dir, oldest));
  }
}

export default async (c: Context) => {
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  const vaultId = vaultOf(c.req.query("vault"));
  if (!vaultId) return c.json({ error: "falta el código" }, 400);
  const dir = join(ROOT, vaultId);
  const currentPath = join(dir, "current.json");

  if (c.req.method === "GET") {
    try {
      const raw = await readFile(currentPath, "utf8");
      const store = asStore(JSON.parse(raw), vaultId);
      if (!store) return c.json({ error: "resguardo ilegible" }, 500);
      return c.json({ store });
    } catch {
      return c.json({ error: "no hay resguardo" }, 404);
    }
  }

  if (c.req.method === "PUT" || c.req.method === "POST") {
    const length = Number(c.req.header("content-length") || "0");
    if (length > MAX_BYTES) return c.json({ error: "demasiado grande" }, 413);
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ error: "json inválido" }, 400);
    }
    const incoming = asStore(parsed, vaultId);
    if (!incoming) return c.json({ error: "copia inválida" }, 400);
    await mkdir(dir, { recursive: true });
    let merged = incoming;
    try {
      const raw = await readFile(currentPath, "utf8");
      const previous = asStore(JSON.parse(raw), vaultId);
      if (previous) merged = merge(previous, incoming, vaultId);
    } catch {
      /* first save for this vault */
    }
    const body = JSON.stringify(merged);
    if (Buffer.byteLength(body) > MAX_BYTES) return c.json({ error: "demasiado grande" }, 413);
    await writeFile(currentPath, body);
    await writeFile(join(dir, `snap-${Date.now()}.json`), body);
    await prune(dir);
    return c.json({ ok: true, savedAt: merged.savedAt });
  }

  return c.json({ error: "método no permitido" }, 405);
};
