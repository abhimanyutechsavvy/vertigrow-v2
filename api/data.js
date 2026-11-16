// /api/data.js
// POST <- Arduino sends readings every 15 s, gets back { mode, cmd }
// GET  -> dashboard reads latest reading + mode + doses
//
// Database use per call (free plan = 500,000 commands/month):
//   Arduino POST: 2 commands (+2 every 2 minutes for history, +a few when a dose finished)
//   Dashboard GET: 3 commands
// Works with the original Arduino sketch too (it only sends ph + tds).

import { pipeline, parse, parseList, str, defaultCtl, readBody, usingDatabase, KEYS } from "./_store.js";

const istDay = iso => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const num = v => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const bool = v => v === true || v === "true" || v === 1;

const HISTORY_MAX = 5000;   // ~1 week at one reading every 2 minutes
const DOSES_MAX = 1000;

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

      // the original sketch doesn't send "hist", so keep every reading from it
      const saveHistory = b.hist === undefined ? true : bool(b.hist);
      const doses = Array.isArray(b.doses) ? b.doses.slice(0, 10) : [];

      const cmds = [
        ["SET", KEYS.latest, str(record)],
        ["GET", KEYS.ctl]
      ];
      if (saveHistory) cmds.push(["LPUSH", KEYS.history, str(record)], ["LTRIM", KEYS.history, "0", String(HISTORY_MAX - 1)]);
      if (doses.length) cmds.push(["LRANGE", KEYS.doses, "0", "59"]);

      const out = await pipeline(cmds);
      let ctl = parse(out[1], defaultCtl());

      const later = [];

      // finished doses reported by the Arduino (skip any already saved)
      if (doses.length) {
        const seen = new Set(parseList(out[out.length - 1]).map(d => String(d.id)));
        const fresh = [];
        for (const d of doses) {
          const pump = String(d.pump || "").toUpperCase();
          if ((pump !== "A" && pump !== "B") || seen.has(String(d.id))) continue;
          seen.add(String(d.id));
          fresh.push(str({ id: d.id, time: record.time, pump, ml: num(d.ml) ?? 0, sec: num(d.sec) ?? 0, auto: bool(d.auto) }));
        }
        if (fresh.length) later.push(["LPUSH", KEYS.doses, ...fresh], ["LTRIM", KEYS.doses, "0", String(DOSES_MAX - 1)]);
      }

      // Arduino confirmed it ran this command -> clear it
      if (ctl.cmd && record.lastCmdId && Number(ctl.cmd.id) === record.lastCmdId) {
        ctl = { ...ctl, cmd: null };
        later.push(["SET", KEYS.ctl, str(ctl)]);
      }
      await pipeline(later);

      return res.status(200).json({ ok: true, mode: ctl.mode || "manual", cmd: ctl.cmd || null });
    }

    /* ================= DASHBOARD READS DATA ================= */
    if (req.method === "GET") {
      const [latestRaw, ctlRaw, dosesRaw] = await pipeline([
        ["GET", KEYS.latest],
        ["GET", KEYS.ctl],
        ["LRANGE", KEYS.doses, "0", "299"]
      ]);
      const latest = parse(latestRaw, { ph: 0, tds: 0, time: null });
      const ctl = parse(ctlRaw, defaultCtl());
      const doses = parseList(dosesRaw);
      const online = latest.time ? Date.now() - new Date(latest.time).getTime() < 45000 : false;

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
        mode: ctl.mode || "manual",
        pendingCmd: ctl.cmd || null,
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
