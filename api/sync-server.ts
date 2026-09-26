import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_SYNC_BYTES = 1_500_000;
const HEX = /^[a-f0-9]{20}$/;
const MAX_SNAPS = 20;

export type SyncBlob = { iv: string; ct: string };
type Saved = { rev: number; blob: SyncBlob; authHash?: string };

export type SyncResponse = { status: number; body: unknown };

type HandleInput = {
  method: string;
  vault: string | null;
  bind: boolean;
  auth: string | null;
  rawBody: Uint8Array | null;
  verifyCredential: (token: string) => Promise<{ sub: string } | null>;
  legacyDesk: (sub: string) => Promise<string>;
};

function vaultOf(raw: string | null): string | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
  return HEX.test(id) ? id : null;
}

function hashAuth(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function authMatches(stored: string, token: string): boolean {
  const candidate = hashAuth(token);
  const left = Buffer.from(stored);
  const right = Buffer.from(candidate);
  return left.length === right.length && timingSafeEqual(left, right);
}

function asBlob(value: unknown): SyncBlob | null {
  if (!value || typeof value !== "object") return null;
  const blob = value as Partial<SyncBlob>;
  if (typeof blob.iv !== "string" || typeof blob.ct !== "string") return null;
  if (blob.iv.length < 8 || blob.iv.length > 64) return null;
  if (blob.ct.length < 8 || blob.ct.length > MAX_SYNC_BYTES) return null;
  return { iv: blob.iv, ct: blob.ct };
}

function asSaved(value: unknown): Saved | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<Saved>;
  const blob = asBlob(saved.blob);
  if (!blob || typeof saved.rev !== "number" || !Number.isFinite(saved.rev) || saved.rev < 1) return null;
  const authHash = typeof saved.authHash === "string" && /^[a-f0-9]{64}$/.test(saved.authHash) ? saved.authHash : undefined;
  return { rev: saved.rev, blob, authHash };
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

async function withLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, ".lock");
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        return await run();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 10_000) await unlink(lockPath).catch(() => undefined);
      } catch {
        /* the holder removed it */
      }
      if (Date.now() - started > 5_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export function createSyncServer(root: string) {
  const accounts = join(root, "accounts");

  async function accountDesk(sub: string, legacy: string): Promise<string> {
    const name = createHash("sha256").update(sub).digest("hex");
    const path = join(accounts, `${name}.json`);
    await mkdir(accounts, { recursive: true });
    return withLock(accounts, async () => {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as { desk?: unknown };
        if (typeof parsed.desk === "string" && HEX.test(parsed.desk)) return parsed.desk;
      } catch {
        /* first bind for this account */
      }
      const legacySaved = await readSaved(join(root, legacy, "current.json"));
      const desk = legacySaved ? legacy : randomBytes(10).toString("hex");
      await writeFile(path, JSON.stringify({ desk }));
      return desk;
    });
  }

  return {
    async handle(input: HandleInput): Promise<SyncResponse> {
      if (input.bind) {
        if (input.method !== "POST") return { status: 405, body: { error: "method" } };
        if (!input.rawBody || input.rawBody.byteLength > 16_000) return { status: 413, body: { error: "too-large" } };
        let credential = "";
        try {
          const parsed = JSON.parse(new TextDecoder().decode(input.rawBody)) as { credential?: unknown };
          credential = typeof parsed.credential === "string" ? parsed.credential : "";
        } catch {
          return { status: 400, body: { error: "json" } };
        }
        const profile = await input.verifyCredential(credential);
        if (!profile) return { status: 401, body: { error: "credential" } };
        const legacy = await input.legacyDesk(profile.sub);
        if (!HEX.test(legacy)) return { status: 400, body: { error: "desk" } };
        const desk = await accountDesk(profile.sub, legacy);
        return { status: 200, body: { desk } };
      }

      const vaultId = vaultOf(input.vault);
      if (!vaultId) return { status: 400, body: { error: "missing" } };
      const dir = join(root, vaultId);
      const currentPath = join(dir, "current.json");

      if (input.method === "GET") {
        const saved = await readSaved(currentPath);
        if (!saved) return { status: 404, body: { error: "missing" } };
        if (saved.authHash && (!input.auth || !authMatches(saved.authHash, input.auth))) {
          return { status: 401, body: { error: "auth" } };
        }
        return { status: 200, body: { rev: saved.rev, blob: saved.blob } };
      }

      if (input.method === "PUT") {
        if (!input.rawBody) return { status: 400, body: { error: "blob" } };
        if (input.rawBody.byteLength > MAX_SYNC_BYTES) return { status: 413, body: { error: "too-large" } };
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(input.rawBody));
        } catch {
          return { status: 400, body: { error: "json" } };
        }
        const body = parsed as { rev?: unknown; blob?: unknown; nextAuth?: unknown };
        const blob = asBlob(body.blob);
        const rev = typeof body.rev === "number" && Number.isFinite(body.rev) ? body.rev : -1;
        const nextAuth = typeof body.nextAuth === "string" && body.nextAuth.length >= 16 ? body.nextAuth : null;
        if (!blob || rev < 0 || !input.auth) return { status: 400, body: { error: "blob" } };
        return withLock(dir, async () => {
          const current = await readSaved(currentPath);
          const currentRev = current?.rev ?? 0;
          if (rev !== currentRev) return { status: 409, body: current ?? { rev: 0, blob: null } };
          if (current?.authHash && !authMatches(current.authHash, input.auth!)) {
            return { status: 401, body: { error: "auth" } };
          }
          const authHash = hashAuth(nextAuth ?? input.auth!);
          const next: Saved = { rev: currentRev + 1, blob, authHash };
          const raw = JSON.stringify(next);
          if (Buffer.byteLength(raw) > MAX_SYNC_BYTES) return { status: 413, body: { error: "too-large" } };
          await mkdir(dir, { recursive: true });
          await writeFile(currentPath, raw);
          await writeFile(join(dir, `snap-${Date.now()}.json`), raw);
          await prune(dir);
          return { status: 200, body: { rev: next.rev, blob: next.blob } };
        });
      }

      return { status: 405, body: { error: "method" } };
    },
  };
}
