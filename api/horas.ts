import type { Context } from "hono";

/** The plaintext vault endpoint is closed. Desks move through the sealed sync API. */
export default async (c: Context) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return c.json({ error: "gone", use: "/api/horas-sync" }, 410);
};
