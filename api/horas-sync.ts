import type { Context } from "hono";
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";

const ROOT = "/home/workspace/horas/sync";
const HEX = /^[a-f0-9]{20}$/;
const MAX_BYTES = 1_500_000;
const MAX_SNAPS = 20;

type Blob = { iv: string; ct: string };
type Saved = { rev: number; blob: Blob };

function cors(c: Context) {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
}

function vaultOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
  return HEX.test(id) ? id : null;
}

function asBlob(value: unknown): Blob | null {
  if (!value || typeof value !== "object") return null;
  const blob = value as Partial<Blob>;
  if (typeof blob.iv !== "string" || typeof blob.ct !== "string") return null;
  if (blob.iv.length < 8 || blob.iv.length > 64) return null;
  if (blob.ct.length < 8 || blob.ct.length > MAX_BYTES) return null;
  return { iv: blob.iv, ct: blob.ct };
}

function asSaved(value: unknown): Saved | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<Saved>;
  const blob = asBlob(saved.blob);
  if (!blob || typeof saved.rev !== "number" || !Number.isFinite(saved.rev) || saved.rev < 1) return null;
  return { rev: saved.rev, blob };
}

async function readSaved(path: string): Promise<Saved | null> {
  try {
    return asSaved(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

async function prune(dir: string): Promise<void> {
  const files = (await readdir(dir)).filter((name) => name.startsWith("snap-") && name.endsWith(".json")).sort();
  while (files.length > MAX_SNAPS) {
    const oldest = files.shift();
    if (oldest) await unlink(join(dir, oldest));
  }
}

export default async (c: Context) => {
  cors(c);
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  const vaultId = vaultOf(c.req.query("vault") ?? c.req.query("desk"));
  if (!vaultId) return c.json({ error: "missing" }, 400);
  const dir = join(ROOT, vaultId);
  const currentPath = join(dir, "current.json");

  if (c.req.method === "GET") {
    const saved = await readSaved(currentPath);
    if (!saved) return c.json({ error: "missing" }, 404);
    return c.json(saved);
  }

  if (c.req.method === "PUT") {
    const length = Number(c.req.header("content-length") || "0");
    if (length > MAX_BYTES) return c.json({ error: "too-large" }, 413);
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ error: "json" }, 400);
    }
    const body = parsed as { rev?: unknown; blob?: unknown };
    const blob = asBlob(body.blob);
    const rev = typeof body.rev === "number" && Number.isFinite(body.rev) ? body.rev : -1;
    if (!blob || rev < 0) return c.json({ error: "blob" }, 400);
    const current = await readSaved(currentPath);
    const currentRev = current?.rev ?? 0;
    if (rev !== currentRev) return c.json(current ?? { rev: 0, blob: null }, 409);
    const next: Saved = { rev: currentRev + 1, blob };
    const raw = JSON.stringify(next);
    if (Buffer.byteLength(raw) > MAX_BYTES) return c.json({ error: "too-large" }, 413);
    await mkdir(dir, { recursive: true });
    await writeFile(currentPath, raw);
    await writeFile(join(dir, `snap-${Date.now()}.json`), raw);
    await prune(dir);
    return c.json(next);
  }

  return c.json({ error: "method" }, 405);
};
