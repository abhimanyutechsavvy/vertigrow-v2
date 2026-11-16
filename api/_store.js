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
      case "SET": mem.kv[key] = a[0]; return "OK";
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

// Vercel normally parses JSON bodies, but be safe if it arrives as text
export function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}
