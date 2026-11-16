// /api/command.js
// Website -> Arduino controls. The Arduino picks these up in its next /api/data call (≤ 5 s).
//
// POST { action: "mode", mode: "auto" | "manual" }
// POST { action: "dose", pump: "A" | "B", seconds: 1-30 }
// POST { action: "stop" }
// GET  -> { mode, cmd }
//
// Optional: set CONTROL_PIN in Vercel env vars so only people with the PIN can run pumps.

import { getJSON, setJSON, readBody, KEYS } from "./_store.js";

const MAX_SECONDS = 30;

// Arduino "long" is 32-bit, so keep IDs below 1,000,000,000 (never 0)
const newId = () => (Date.now() % 1000000000) || 1;

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const mode = (await getJSON(KEYS.mode, "manual")) || "manual";
      const cmd = await getJSON(KEYS.cmd, null);
      return res.status(200).json({ mode, cmd });
    }

    if (req.method !== "POST") return res.status(405).end();

    const b = readBody(req);

    if (process.env.CONTROL_PIN && String(b.pin || "") !== String(process.env.CONTROL_PIN)) {
      return res.status(401).json({ ok: false, error: "need_pin" });
    }

    if (b.action === "mode") {
      if (b.mode !== "auto" && b.mode !== "manual") {
        return res.status(400).json({ ok: false, error: "mode must be auto or manual" });
      }
      await setJSON(KEYS.mode, b.mode);
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
      await setJSON(KEYS.cmd, cmd);
      return res.status(200).json({ ok: true, cmd });
    }

    if (b.action === "stop") {
      const cmd = { id: newId(), action: "stop", time: new Date().toISOString() };
      await setJSON(KEYS.cmd, cmd);
      return res.status(200).json({ ok: true, cmd });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  } catch (err) {
    console.error("COMMAND ERROR:", err);
    return res.status(500).json({ ok: false, error: "command error", detail: err.message });
  }
}
