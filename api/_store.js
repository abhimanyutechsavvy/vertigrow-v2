import crypto from "crypto";
// /api/_store.js  (files starting with "_" are helpers, not API routes)
//
// Saves VertiGrow data in Upstash Redis (Vercel -> Storage -> Upstash Redis).
// Vercel adds KV_REST_API_URL + KV_REST_API_TOKEN when the database is connected.
//
// The free Upstash plan allows 500,000 commands a month, so every request here
// sends its commands together in ONE pipeline and keeps the count small.
// Without a database it falls back to memory (can reset at any time on Vercel).

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const usingDatabase = Boolean(URL_ && TOKEN);

export const KEYS = {
  latest: "vg:latest",    // newest reading from the Arduino
  ctl: "vg:ctl",          // { mode, cmd } set by the website
  history: "vg:history",  // reading every ~2 minutes (for Excel)
  doses: "vg:doses"       // every nutrient dose
};

const mem = (globalThis.__VG_MEM__ = globalThis.__VG_MEM__ || { kv: {}, lists: {} });

// same commands, emulated in memory when there is no database
function runInMemory(cmds) {
  return cmds.map(([op, key, ...a]) => {
    switch (op) {
      case "GET": return mem.kv[key] ?? null;
      case "SET":
        if (a.includes("NX") && mem.kv[key] !== undefined) return null;
        mem.kv[key] = a[0]; return "OK";
      case "INCR": mem.kv[key] = String((parseInt(mem.kv[key] || "0", 10) || 0) + 1); return +mem.kv[key];
      case "DEL": delete mem.kv[key]; return 1;
      case "LPUSH": { const l = (mem.lists[key] = mem.lists[key] || []); l.unshift(...a); return l.length; }
      case "LTRIM": { const l = mem.lists[key] || []; mem.lists[key] = l.slice(+a[0], +a[1] + 1); return "OK"; }
      case "LRANGE": return (mem.lists[key] || []).slice(+a[0], +a[1] + 1);
      default: throw new Error("unsupported " + op);
    }
  });
}

// run several commands in one round trip; returns their results in order
export async function pipeline(cmds) {
  if (!cmds.length) return [];
  if (!usingDatabase) return runInMemory(cmds);
  const r = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error("Redis error " + r.status);
  const out = await r.json();
  return out.map(x => {
    if (x.error) throw new Error("Redis: " + x.error);
    return x.result;
  });
}

export const parse = (v, fallback = null) => {
  if (v === null || v === undefined) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};
export const parseList = items => (items || []).map(s => parse(s)).filter(Boolean);
export const str = v => JSON.stringify(v);

export const defaultCtl = () => ({ mode: "manual", cmd: null });

/* ---------------- security helpers ---------------- */
// caller's IP as Vercel reports it
export function clientIp(req) {
  const f = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (f || req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown").slice(0, 64);
}

// cut text to a safe length (and make sure it is text)
export const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

// compare secrets without leaking timing
export function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// cheap per-instance limiter (no database cost): true = allowed
const hits = (globalThis.__VG_HITS__ = globalThis.__VG_HITS__ || new Map());
export function memLimit(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now > h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  return h.n <= max;
}

// shared counter in Redis with a time window; returns the new count
export async function bump(key, windowSec) {
  const out = await pipeline([["SET", key, "0", "EX", String(windowSec), "NX"], ["INCR", key]]);
  return Number(out[1]) || 0;
}
export async function peek(key) {
  const [v] = await pipeline([["GET", key]]);
  return Number(v) || 0;
}

// Vercel normally parses JSON bodies, but be safe if it arrives as text
export function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}
