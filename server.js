// Angeles Productions Arcade — Guestbook service
// Zero-dependency Node server. Entries live in an Upstash Redis list
// (key "guestbook:entries") via the Upstash REST API. If the Upstash
// env vars are absent (local dev), it falls back to in-memory storage
// so the service can be smoke-tested without credentials.
//
// Endpoints:
//   GET    /api/entries           -> { entries: [{name, message, ts}] } newest first
//   POST   /api/entries           -> {name, message, website?} adds an entry
//                                    ("website" is a honeypot; real visitors never fill it)
//   DELETE /api/entries           -> header x-admin-token + body {ts} removes one entry
//   GET    /                      -> health text
//
// Env:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (storage; set in Render)
//   ADMIN_TOKEN                                       (enables DELETE)
//   PORT                                              (Render provides)

import http from "node:http";

const PORT = process.env.PORT || 10000;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const KEY = "guestbook:entries";
const MAX_ENTRIES = 200;
const ALLOWED_ORIGINS = new Set([
  "https://angeles-productions-arcade.onrender.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

const memory = []; // dev fallback, newest first

async function redis(cmd) {
  const res = await fetch(`${UPSTASH_URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function listEntries() {
  if (!UPSTASH_URL) return memory.slice(0, MAX_ENTRIES);
  const raw = await redis(["LRANGE", KEY, "0", String(MAX_ENTRIES - 1)]);
  return (raw || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

async function addEntry(entry) {
  if (!UPSTASH_URL) { memory.unshift(entry); memory.length = Math.min(memory.length, MAX_ENTRIES); return; }
  await redis(["LPUSH", KEY, JSON.stringify(entry)]);
  await redis(["LTRIM", KEY, "0", String(MAX_ENTRIES - 1)]);
}

async function removeEntry(ts) {
  const entries = await listEntries();
  const target = entries.find((e) => e.ts === ts);
  if (!target) return false;
  if (!UPSTASH_URL) {
    const i = memory.findIndex((e) => e.ts === ts);
    if (i >= 0) memory.splice(i, 1);
    return true;
  }
  const removed = await redis(["LREM", KEY, "1", JSON.stringify(target)]);
  return removed > 0;
}

// crude per-IP rate limit: 1 post / 5s, 10 posts / hour
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (arr.length && now - arr[arr.length - 1] < 5000) return true;
  if (arr.length >= 10) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

function clean(s, max) {
  return String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function send(res, code, obj, origin) {
  const headers = { "Content-Type": "application/json" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    const headers = {};
    if (ALLOWED_ORIGINS.has(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type, x-admin-token";
    }
    res.writeHead(204, headers);
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("angeles arcade guestbook: ok\n");
    }
    if (req.method === "GET" && url.pathname === "/api/entries") {
      return send(res, 200, { entries: await listEntries() }, origin);
    }
    if (req.method === "POST" && url.pathname === "/api/entries") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body || "{}");
          if (data.website) return send(res, 200, { ok: true }, origin); // honeypot: silently accept
          const name = clean(data.name, 24);
          const message = clean(data.message, 280);
          if (!name || !message) return send(res, 400, { error: "name and message required" }, origin);
          if (/https?:|www\./i.test(message) || /https?:|www\./i.test(name)) {
            return send(res, 400, { error: "links are not allowed on the wall" }, origin);
          }
          const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").toString().split(",")[0];
          if (rateLimited(ip)) return send(res, 429, { error: "slow down — one signature at a time" }, origin);
          const entry = { name, message, ts: Date.now() };
          await addEntry(entry);
          return send(res, 201, { ok: true, entry }, origin);
        } catch {
          return send(res, 400, { error: "bad request" }, origin);
        }
      });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/entries") {
      if (!ADMIN_TOKEN || req.headers["x-admin-token"] !== ADMIN_TOKEN) {
        return send(res, 403, { error: "forbidden" }, origin);
      }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        try {
          const { ts } = JSON.parse(body || "{}");
          const ok = await removeEntry(Number(ts));
          return send(res, ok ? 200 : 404, { ok }, origin);
        } catch {
          return send(res, 400, { error: "bad request" }, origin);
        }
      });
      return;
    }
    return send(res, 404, { error: "not found" }, origin);
  } catch (e) {
    return send(res, 500, { error: "server error" }, origin);
  }
});

server.listen(PORT, () => console.log(`guestbook listening on ${PORT}`));
