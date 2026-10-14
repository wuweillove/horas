import { squareRequest } from "./square-server.ts";

function json(result: { status: number; body: unknown }): Response {
  return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
}

export async function GET(): Promise<Response> {
  return json(await squareRequest({ method: "GET", rawBody: null, env: process.env, fetch: globalThis.fetch }));
}

export async function POST(request: Request): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  return json(await squareRequest({ method: "POST", rawBody: raw, env: process.env, fetch: globalThis.fetch }));
}
