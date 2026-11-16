// /api/data.js
// POST <- Arduino sends all readings every 5 s, gets back { mode, cmd }
// GET  -> dashboard reads latest readings + mode + pending command
//
// Works with the original Arduino sketch too (it only sends ph + tds).

import { getJSON, setJSON, del, pushHistory, getHistory, readBody, usingDatabase, KEYS } from "./_store.js";

const istDay = iso => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const num = v => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const bool = v => v === true || v === "true" || v === 1;

export default async function handler(req, res) {
  try {
    /* ================= ARDUINO SENDS DATA ================= */
    if (req.method === "POST") {
      const b = readBody(req);

      if (process.env.DEVICE_KEY && b.key !== process.env.DEVICE_KEY) {
        return res.status(401).json({ error: "bad device key" });
      }

      const record = {
        time: new Date().toISOString(),
        ph: num(b.ph) ?? 0,
        tds: num(b.tds) ?? 0,
        phOk: b.phOk === undefined ? num(b.ph) > 0 : bool(b.phOk),
        tdsOk: b.tdsOk === undefined ? num(b.tds) > 0 : bool(b.tdsOk),
        phV: num(b.phV),
        mainOk: bool(b.mainOk), mainPct: num(b.mainPct), mainCm: num(b.mainCm),
        aOk: bool(b.aOk),       aPct: num(b.aPct),       aCm: num(b.aCm),
        bOk: bool(b.bOk),       bPct: num(b.bPct),       bCm: num(b.bCm),
        mainL: num(b.mainL),    aMl: num(b.aMl),         bMl: num(b.bMl),
        rateA: num(b.rateA),    rateB: num(b.rateB),
        remindMain: num(b.remindMain), remindNpk: num(b.remindNpk),
        pumpA: bool(b.pumpA),
        pumpB: bool(b.pumpB),
        deviceMode: b.mode || null,
        autoStatus: b.autoStatus || null,
        lastCmdId: num(b.lastCmdId)
      };

      await setJSON(KEYS.latest, record);
      await pushHistory(KEYS.history, record);

      // finished doses reported by the Arduino (skip any already saved)
      if (Array.isArray(b.doses) && b.doses.length) {
        const recent = await getHistory(KEYS.doses, 60);
        const seen = new Set(recent.map(d => String(d.id)));
        for (const d of b.doses.slice(0, 10)) {
          const pump = String(d.pump || "").toUpperCase();
          if ((pump !== "A" && pump !== "B") || seen.has(String(d.id))) continue;
          seen.add(String(d.id));
          await pushHistory(KEYS.doses, {
            id: d.id,
            time: record.time,
            pump,
            ml: num(d.ml) ?? 0,
            sec: num(d.sec) ?? 0,
            auto: bool(d.auto)
          }, 1000);
        }
      }

      const mode = (await getJSON(KEYS.mode, "manual")) || "manual";
      let cmd = await getJSON(KEYS.cmd, null);

      // Arduino confirmed it ran this command -> clear it
      if (cmd && record.lastCmdId && Number(cmd.id) === record.lastCmdId) {
        await del(KEYS.cmd);
        cmd = null;
      }

      return res.status(200).json({ ok: true, mode, cmd });
    }

    /* ================= DASHBOARD READS DATA ================= */
    if (req.method === "GET") {
      const latest = (await getJSON(KEYS.latest, null)) || { ph: 0, tds: 0, time: null };
      const mode = (await getJSON(KEYS.mode, "manual")) || "manual";
      const cmd = await getJSON(KEYS.cmd, null);
      const online = latest.time ? Date.now() - new Date(latest.time).getTime() < 20000 : false;

      const doses = await getHistory(KEYS.doses, 300);
      const today = istDay(new Date().toISOString());
      const doseToday = { A: 0, B: 0, count: 0 };
      for (const d of doses) {
        if (istDay(d.time) !== today) continue;
        doseToday[d.pump] += d.ml;
        doseToday.count++;
      }
      doseToday.A = Math.round(doseToday.A * 10) / 10;
      doseToday.B = Math.round(doseToday.B * 10) / 10;

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        ...latest,
        mode,
        pendingCmd: cmd,
        doseToday,
        recentDoses: doses.slice(0, 6),
        online,
        storage: usingDatabase ? "database" : "memory"
      });
    }

    return res.status(405).end();
  } catch (err) {
    console.error("DATA ERROR:", err);
    return res.status(500).json({ error: "data error", detail: err.message });
  }
}
