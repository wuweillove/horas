import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSyncServer } from "../api/sync-server.ts";
import { syncAuthToken } from "./sync.ts";

const blob = { iv: "abcdefghijk", ct: "ciphertext-body" };

test("a desk write requires the auth token and a matching revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "horas-sync-"));
  const server = createSyncServer(root);
  const auth = await syncAuthToken("a".repeat(43));
  const other = await syncAuthToken("b".repeat(43));
  const vault = "ab".repeat(10);

  const denied = await server.handle(call("PUT", vault, null, { rev: 0, blob }));
  assert.equal(denied.status, 400);

  const created = await server.handle(call("PUT", vault, auth, { rev: 0, blob }));
  assert.equal(created.status, 200);

  const open = await server.handle(call("GET", vault, null, null));
  assert.equal(open.status, 401);
  const read = await server.handle(call("GET", vault, auth, null));
  assert.equal(read.status, 200);
  assert.equal((read.body as { rev: number }).rev, 1);

  const wrong = await server.handle(call("PUT", vault, other, { rev: 1, blob }));
  assert.equal(wrong.status, 401);
  const stale = await server.handle(call("PUT", vault, auth, { rev: 0, blob }));
  assert.equal(stale.status, 409);

  const huge = new Uint8Array(1_500_001);
  const oversized = await server.handle({ ...call("PUT", vault, auth, null), rawBody: huge });
  assert.equal(oversized.status, 413);
});

test("Google bind returns the legacy desk when one exists, and the same desk after that", async () => {
  const root = await mkdtemp(join(tmpdir(), "horas-bind-"));
  const legacy = "cd".repeat(10);
  await mkdir(join(root, legacy), { recursive: true });
  await writeFile(join(root, legacy, "current.json"), JSON.stringify({ rev: 1, blob }));
  const server = createSyncServer(root);
  const verify = async (token: string) => (token === "good" ? { sub: "account-sub" } : null);
  const first = await server.handle({
    method: "POST",
    vault: null,
    bind: true,
    auth: null,
    rawBody: new TextEncoder().encode(JSON.stringify({ credential: "good" })),
    verifyCredential: verify,
    legacyDesk: async () => legacy,
  });
  assert.equal(first.status, 200);
  assert.equal((first.body as { desk: string }).desk, legacy);
  const again = await server.handle({
    method: "POST",
    vault: null,
    bind: true,
    auth: null,
    rawBody: new TextEncoder().encode(JSON.stringify({ credential: "good" })),
    verifyCredential: verify,
    legacyDesk: async () => "ff".repeat(10),
  });
  assert.equal((again.body as { desk: string }).desk, legacy);
  const rejected = await server.handle({
    method: "POST",
    vault: null,
    bind: true,
    auth: null,
    rawBody: new TextEncoder().encode(JSON.stringify({ credential: "bad" })),
    verifyCredential: verify,
    legacyDesk: async () => legacy,
  });
  assert.equal(rejected.status, 401);
});

function call(method: string, vault: string, auth: string | null, body: unknown) {
  return {
    method,
    vault,
    bind: false,
    auth,
    rawBody: body === null ? null : new TextEncoder().encode(JSON.stringify(body)),
    verifyCredential: async () => null,
    legacyDesk: async () => "00".repeat(10),
  };
}
