import type { Context } from "hono";
import { deskFromGoogle, verifyGoogleCredential } from "../src/google.ts";
import { createSyncServer, MAX_SYNC_BYTES } from "./sync-server.ts";

const server = createSyncServer("/home/workspace/horas/sync");

function cors(c: Context) {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, X-Horas-Auth");
}

export default async (c: Context) => {
  cors(c);
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  const raw = c.req.method === "GET" ? null : new Uint8Array(await c.req.arrayBuffer());
  if (raw && raw.byteLength > MAX_SYNC_BYTES) return c.json({ error: "too-large" }, 413);
  const result = await server.handle({
    method: c.req.method,
    vault: c.req.query("vault") ?? c.req.query("desk") ?? null,
    bind: c.req.query("bind") === "1",
    auth: c.req.header("x-horas-auth") ?? null,
    rawBody: raw,
    verifyCredential: async (token) => {
      const profile = await verifyGoogleCredential(token);
      return profile ? { sub: profile.sub } : null;
    },
    legacyDesk: async (sub) => (await deskFromGoogle(sub)).desk,
  });
  return c.json(result.body, result.status as 200);
};
