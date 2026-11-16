// /api/_store.js  (files starting with "_" are helpers, not API routes)
//
// Saves VertiGrow data in Upstash Redis (Vercel -> Storage -> Upstash Redis).
// Vercel adds these env variables automatically when you connect the database:
//   KV_REST_API_URL + KV_REST_API_TOKEN     (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//
// Without a database it falls back to memory, which on Vercel can reset at any
// time (that's why values used to jump back to 0 and Excel said "No data").

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const usingDatabase = Boolean(URL_ && TOKEN);

const mem = (globalThis.__VG_MEM__ = globalThis.__VG_MEM__ || {
  kv: {},
  lists: {}
});

async function redis(commands) {
  const r = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error("Redis error " + r.status);
  const out = await r.json();
  return out.map(x => x.result);
}

export async function getJSON(key, fallback = null) {
  if (!usingDatabase) return mem.kv[key] ?? fallback;
  const [v] = await redis([["GET", key]]);
  if (v === null || v === undefined) return fallback;
  try { return JSON.parse(v); } catch { return v; }
}

export async function setJSON(key, value) {
  if (!usingDatabase) { mem.kv[key] = value; return; }
  await redis([["SET", key, JSON.stringify(value)]]);
}

export async function del(key) {
  if (!usingDatabase) { delete mem.kv[key]; return; }
  await redis([["DEL", key]]);
}

// newest first, keeps the last `max` items
export async function pushHistory(key, value, max = 2000) {
  if (!usingDatabase) {
    const l = (mem.lists[key] = mem.lists[key] || []);
    l.unshift(value);
    l.length = Math.min(l.length, max);
    return;
  }
  await redis([
    ["LPUSH", key, JSON.stringify(value)],
    ["LTRIM", key, "0", String(max - 1)]
  ]);
}

export async function getHistory(key, max = 2000) {
  if (!usingDatabase) return (mem.lists[key] || []).slice(0, max);
  const [items] = await redis([["LRANGE", key, "0", String(max - 1)]]);
  return (items || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

// Vercel normally parses JSON bodies, but be safe if it arrives as text
export function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

export const KEYS = {
  latest: "vg:latest",
  history: "vg:history",
  mode: "vg:mode",
  cmd: "vg:cmd",
  doses: "vg:doses"
};
