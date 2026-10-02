import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { squareRequest } from "./api/square-server.ts";

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function squareDev() {
  return {
    name: "horas-square",
    configureServer(server: { middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        if (path !== "/api/square") {
          next();
          return;
        }
        void (async () => {
          const rawBody = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
          const result = await squareRequest({
            method: req.method ?? "GET",
            rawBody,
            env: process.env,
            fetch: globalThis.fetch,
          });
          res.statusCode = result.status;
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(result.body));
        })().catch(() => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "Square didn't answer." }));
        });
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), squareDev()],
  server: { host: "0.0.0.0", port: 5173 },
});
