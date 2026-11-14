import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import ts from "typescript";
import { StudioApp } from "./app.js";
import type { AppOptions } from "./app.js";
import { artifactSchemas, artifactRefSchema } from "./domain/schemas.js";
import { StudioError } from "./domain/errors.js";
import { sha256File } from "./domain/hash.js";
import { createFixtureAdapters } from "./media/pipeline.js";

const BODY_LIMIT = 1024 * 1024;
const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const mediaTypes: Record<string, string> = {
  ".mp4": "video/mp4", ".wav": "audio/wav", ".png": "image/png", ".svg": "image/svg+xml",
  ".vtt": "text/vtt; charset=utf-8", ".srt": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new StudioError("CONTENT_TYPE", "Send JSON with application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += data.length;
    if (size > BODY_LIMIT) throw new StudioError("BODY_LIMIT", "The request exceeds the 1 MB local input limit.");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new StudioError("JSON_INVALID", "Fix the JSON syntax before saving."); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function startStudioServer(options: AppOptions & { port?: number } = {}) {
  const app = await StudioApp.open(options);
  const root = app.root;
  const clientFile = join(dirname(fileURLToPath(import.meta.url)), "ui", "client.js");
  const client = existsSync(clientFile) ? readFileSync(clientFile, "utf8") : ts.transpileModule(
    readFileSync(join(root, "src", "ui", "client.ts"), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, verbatimModuleSyntax: true } },
  ).outputText;
  let port = options.port ?? 4317;
  const server = createServer((request, response) => {
    response.setHeader("Content-Security-Policy", policy);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
      const status = error instanceof z.ZodError ? 400
        : error instanceof StudioError ? (error.classification === "stale" ? 409 : 400) : 500;
      const message = error instanceof Error ? error.message : "Unknown local server failure";
      if (status === 500) console.error("Review server error:", message);
      json(response, status, { error: message });
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!host || !hosts.includes(host)) { json(response, 403, { error: "Use the loopback studio address." }); return; }
    const url = new URL(request.url ?? "/", `http://${host}`);
    const origin = request.headers.origin;
    if (origin && !hosts.some((candidate) => origin === `http://${candidate}`)) {
      json(response, 403, { error: "Cross-origin access to local studio data is disabled." }); return;
    }
    if (request.method === "POST") {
      const submitted = request.headers["x-studio-token"];
      const token = typeof submitted === "string" ? Buffer.from(submitted) : Buffer.alloc(0);
      const expected = Buffer.from(app.token);
      if (!origin || token.length !== expected.length || !timingSafeEqual(token, expected)) {
        json(response, 403, { error: "A same-origin review session token is required." }); return;
      }
      const data = await body(request);
      switch (url.pathname) {
        case "/api/fixture": await app.loadFixture(); json(response, 201, { created: true }); return;
        case "/api/fixture/render": json(response, 202, { jobId: app.renderFixture() }); return;
        case "/api/artifacts": json(response, 201, app.saveArtifact(data)); return;
        case "/api/decisions": app.decide(data); json(response, 200, { recorded: true }); return;
        case "/api/revisions": json(response, 202, { jobId: app.revise(data) }); return;
        case "/api/recover": json(response, 200, { recovered: app.controller.recover() }); return;
        case "/api/jobs": {
          const input = z.object({ workflowId: z.string(), artifacts: z.array(artifactRefSchema).default([]) }).strict().parse(data);
          const job = app.controller.start(input.workflowId, { artifacts: input.artifacts });
          app.schedule(job.id); json(response, 202, { jobId: job.id }); return;
        }
      }
      const match = /^\/api\/jobs\/([^/]+)\/(run|cancel)$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        if (!app.store.getJob(id)) { json(response, 404, { error: "Job not found." }); return; }
        if (match[2] === "cancel") app.controller.cancel(id);
        else {
          const additions = z.object({ artifacts: z.array(artifactRefSchema).optional() }).strict().parse(data);
          const job = app.store.getJob(id)!;
          if (job.status === "paused" || job.status === "cancelled") app.controller.resume(id, additions.artifacts);
          app.schedule(id);
        }
        json(response, 202, { jobId: id }); return;
      }
      json(response, 404, { error: "This local operation is not implemented. Providers, purchases, uploads and publishing are disabled." }); return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") { json(response, 405, { error: "Method not allowed." }); return; }
    if (url.pathname === "/api/state") { json(response, 200, app.state()); return; }
    if (url.pathname === "/health") { json(response, 200, { ready: true, localOnly: true, providerEffects: "disabled" }); return; }
    if (url.pathname === "/media") {
      const id = url.searchParams.get("id");
      const version = Number(url.searchParams.get("version"));
      const artifact = id ? app.store.listArtifacts({ currentOnly: false }).find((record) =>
        record.id === id && record.version === version && record.kind === "asset") : undefined;
      if (!artifact) { json(response, 404, { error: "Local asset not found." }); return; }
      const asset = artifactSchemas.asset.parse(artifact.content);
      if (asset.path.split(/[\\/]/)[0] !== ".studio") throw new StudioError("MEDIA_PATH", "Only private studio exports can be previewed.");
      const file = realpathSync(resolve(root, ...asset.path.split(/[\\/]/)));
      const location = relative(realpathSync(join(root, ".studio")), file);
      if (location === ".." || location.startsWith(`..${sep}`) || /^[a-zA-Z]:/.test(location)) throw new StudioError("MEDIA_PATH", "Media cannot escape private studio storage.");
      const type = mediaTypes[extname(file).toLowerCase()];
      if (!type) throw new StudioError("MEDIA_TYPE", "This file type cannot be served as review media.");
      if (sha256File(file) !== asset.sha256) throw new StudioError("MEDIA_HASH", "The local asset changed. Regenerate and register its current version.");
      const size = statSync(file).size;
      let start = 0; let end = size - 1; let status = 200;
      if (request.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (range) {
          start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        }
        if (!range || !Number.isSafeInteger(start) || start < 0 || start > end || end >= size) {
          response.writeHead(416, { "Content-Range": `bytes */${size}` }); response.end(); return;
        }
        status = 206;
      }
      response.writeHead(status, {
        "Content-Type": type, "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Cache-Control": "no-store",
        ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      if (request.method === "HEAD") { response.end(); return; }
      const stream = createReadStream(file, { start, end });
      stream.on("error", (error) => response.destroy(error));
      response.on("close", () => stream.destroy());
      stream.pipe(response); return;
    }
    const assets: Record<string, { content: string; type: string }> = {
      "/": { content: readFileSync(join(root, "public", "index.html"), "utf8"), type: "text/html; charset=utf-8" },
      "/styles.css": { content: readFileSync(join(root, "public", "styles.css"), "utf8"), type: "text/css; charset=utf-8" },
      "/client.js": { content: client, type: "text/javascript; charset=utf-8" },
    };
    const asset = assets[url.pathname];
    if (!asset) { json(response, 404, { error: "Page not found." }); return; }
    response.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : asset.content);
  }
  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); accept(); });
    });
  } catch (error) { await app.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new StudioError("SERVER_ADDRESS", "The local server did not obtain a loopback address.");
  port = address.port;
  let ticking = false;
  const worker = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void app.tick().catch((error: unknown) => console.error("Local queue error:", error instanceof Error ? error.message : "Unknown error"))
      .finally(() => { ticking = false; });
  }, 1000);
  worker.unref();
  return {
    app, server, url: `http://127.0.0.1:${port}`,
    async close() {
      clearInterval(worker);
      await app.close();
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env["STUDIO_PORT"] ?? 4317);
  const studio = await startStudioServer({
    port, fixtureAdapters: createFixtureAdapters,
    ...(process.env["STUDIO_DATA"] ? { dataDirectory: process.env["STUDIO_DATA"] } : {}),
  });
  console.log(`AI Course Studio ready: ${studio.url} (local only; provider effects disabled)`);
  const shutdown = () => { void studio.close().then(() => process.exit(0)).catch((error: unknown) => { console.error(error); process.exitCode = 1; }); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}
