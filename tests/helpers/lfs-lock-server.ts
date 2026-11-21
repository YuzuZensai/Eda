import { createServer } from "node:http";
import assert from "node:assert/strict";

export async function lfsLockServer(path: string) {
  const lock = {
    id: "1",
    path,
    locked_at: "2026-01-01T00:00:00Z",
    owner: { name: "fixture" },
  };
  let locked = false;
  let supported = true;
  const server = createServer((req, res) => {
    const route = new URL(req.url ?? "/", "http://localhost").pathname;
    res.setHeader("Content-Type", "application/vnd.git-lfs+json");
    if (!supported) {
      res.writeHead(501);
      res.end(JSON.stringify({ message: "Locking unavailable" }));
      return;
    }
    if (route.endsWith("/locks") && req.method === "GET") {
      res.end(JSON.stringify({ locks: locked ? [lock] : [] }));
      return;
    }
    if (route.endsWith("/locks") && req.method === "POST") {
      locked = true;
      res.writeHead(201);
      res.end(JSON.stringify({ lock }));
      return;
    }
    if (route.endsWith("/locks/1/unlock") && req.method === "POST") {
      locked = false;
      res.end(JSON.stringify({ lock }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: "http://127.0.0.1:" + address.port + "/info/lfs",
    isLocked: () => locked,
    disable: () => {
      supported = false;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
