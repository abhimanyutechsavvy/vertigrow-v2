// /api/command.js
// Website -> Arduino controls. The Arduino picks these up on its next upload (within ~15 s).
//
// POST { action: "mode", mode: "auto" | "manual" }
// POST { action: "dose", pump: "A" | "B", seconds: 1-30 }
// POST { action: "stop" }
// GET  -> { mode, cmd }
//
// Set CONTROL_PIN in Vercel env vars so only people with the PIN can run pumps.

import crypto from "crypto";
import { pipeline, parse, str, defaultCtl, readBody, KEYS, clientIp, safeEqual, bump, peek, memLimit, foreignOrigin, publicCmd } from "./_store.js";

const MAX_SECONDS = 30;

// wrong-PIN protection: 5 wrong tries per IP -> 15 min lock;
// 50 wrong tries across the whole site in a day -> controls locked for the rest of that day
const IP_FAILS = 5, IP_LOCK_SEC = 900, ALL_FAILS = 50, ALL_LOCK_SEC = 86400;

// random, unguessable IDs; Arduino "long" is 32-bit, so keep them below 1,000,000,000 (never 0)
const newId = () => crypto.randomInt(1, 1000000000);

async function getCtl() {
  const [raw] = await pipeline([["GET", KEYS.ctl]]);
  return parse(raw, defaultCtl());
}
async function setCtl(ctl) {
  await pipeline([["SET", KEYS.ctl, str(ctl)]]);
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const ctl = await getCtl();
      return res.status(200).json({ mode: ctl.mode || "manual", cmd: publicCmd(ctl.cmd) });
    }

    if (req.method !== "POST") return res.status(405).end();

    if (foreignOrigin(req)) return res.status(403).json({ ok: false, error: "forbidden" });

    const ip = clientIp(req);
    if (!memLimit("cmd:" + ip, 20, 60000)) {
      return res.status(429).json({ ok: false, error: "too many requests, wait a minute" });
    }

    const b = readBody(req);

    if (process.env.CONTROL_PIN) {
      const ipKey = "vg:pinfail:" + ip, allKey = "vg:pinfail:all";
      const [ipFails, allFails] = await Promise.all([peek(ipKey), peek(allKey)]);
      if (ipFails >= IP_FAILS || allFails >= ALL_FAILS) {
        return res.status(429).json({ ok: false, error: allFails >= ALL_FAILS
          ? "controls locked for today after too many wrong PIN tries"
          : "too many wrong PIN tries, wait 15 minutes" });
      }
      if (!safeEqual(b.pin || "", process.env.CONTROL_PIN)) {
        if (b.pin) await Promise.all([bump(ipKey, IP_LOCK_SEC), bump(allKey, ALL_LOCK_SEC)]);
        return res.status(401).json({ ok: false, error: "need_pin" });
      }
    }

    const ctl = await getCtl();

    if (b.action === "mode") {
      if (b.mode !== "auto" && b.mode !== "manual") {
        return res.status(400).json({ ok: false, error: "mode must be auto or manual" });
      }
      await setCtl({ ...ctl, mode: b.mode });
      return res.status(200).json({ ok: true, mode: b.mode });
    }

    if (b.action === "dose") {
      const pump = String(b.pump || "").toUpperCase();
      const seconds = Math.round(Number(b.seconds));
      if (pump !== "A" && pump !== "B") {
        return res.status(400).json({ ok: false, error: "pump must be A or B" });
      }
      if (!seconds || seconds < 1 || seconds > MAX_SECONDS) {
        return res.status(400).json({ ok: false, error: `seconds must be 1-${MAX_SECONDS}` });
      }
      const cmd = { id: newId(), action: "dose", pump, seconds, time: new Date().toISOString() };
      await setCtl({ ...ctl, cmd });
      return res.status(200).json({ ok: true, cmd: publicCmd(cmd) });
    }

    if (b.action === "stop") {
      const cmd = { id: newId(), action: "stop", time: new Date().toISOString() };
      await setCtl({ ...ctl, cmd });
      return res.status(200).json({ ok: true, cmd: publicCmd(cmd) });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  } catch (err) {
    console.error("COMMAND ERROR:", err);
    return res.status(500).json({ ok: false, error: "command error" });
  }
}
