// /api/export.js
// GET -> vertigrow_report.xlsx with full reading history (newest first)
// History needs the Upstash Redis database; without it only the latest reading is exported.

import XLSX from "xlsx";
import { getHistory, getJSON, KEYS } from "./_store.js";

const yesNo = v => (v ? "Yes" : "No");
const val = v => (v === null || v === undefined ? "" : v);

function health(r) {
  const phGood = r.ph >= 5.8 && r.ph <= 6.5, tdsGood = r.tds >= 800 && r.tds <= 1200;
  const phMid = r.ph >= 5.5 && r.ph <= 6.8,  tdsMid = r.tds >= 600 && r.tds <= 1400;
  const p = r.phOk !== false, t = r.tdsOk !== false;
  if (!p && !t) return "No sensor";
  const good = (!p || phGood) && (!t || tdsGood);
  const mid = (!p || phMid) && (!t || tdsMid);
  return good ? "GOOD" : mid ? "MODERATE" : "BAD";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).end();

    let rows = await getHistory(KEYS.history, 2000);
    if (!rows.length) {
      const latest = await getJSON(KEYS.latest, null);
      if (latest && latest.time) rows = [latest];
    }
    if (!rows.length) return res.status(200).send("No data available yet - is the Arduino sending?");

    const sheetRows = rows.map(r => ({
      "Time (IST)": new Date(r.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      "pH": r.phOk === false ? "n/a" : r.ph,
      "TDS (ppm)": r.tdsOk === false ? "n/a" : r.tds,
      "Health": health(r),
      "Main tank %": val(r.mainPct),
      "Main tank cm": val(r.mainCm),
      "Main tank litres": val(r.mainL),
      "NPK A tank %": val(r.aPct),
      "NPK A left (ml)": val(r.aMl),
      "NPK B tank %": val(r.bPct),
      "NPK B left (ml)": val(r.bMl),
      "Pump A on": yesNo(r.pumpA),
      "Pump B on": yesNo(r.pumpB),
      "Mode": val(r.deviceMode),
      "Auto status": val(r.autoStatus)
    }));

    const ws = XLSX.utils.json_to_sheet(sheetRows);
    ws["!cols"] = Object.keys(sheetRows[0]).map(k => ({ wch: Math.max(12, k.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Readings");

    // second sheet: every nutrient dose
    const doses = await getHistory(KEYS.doses, 1000);
    const doseRows = doses.length
      ? doses.map(d => ({
          "Time (IST)": new Date(d.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
          "Nutrient": "NPK " + d.pump,
          "Amount (ml)": d.ml,
          "Pump ran (sec)": d.sec,
          "Started by": d.auto ? "Auto" : "Manual (website)"
        }))
      : [{ "Time (IST)": "No doses recorded yet" }];
    const ws2 = XLSX.utils.json_to_sheet(doseRows);
    ws2["!cols"] = Object.keys(doseRows[0]).map(k => ({ wch: Math.max(14, k.length + 2) }));
    XLSX.utils.book_append_sheet(wb, ws2, "Nutrient doses");
    const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

    res.setHeader("Content-Disposition", "attachment; filename=vertigrow_report.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return res.status(200).send(buffer);
  } catch (e) {
    console.error("EXCEL ERROR:", e);
    return res.status(500).send("Excel export failed");
  }
}
