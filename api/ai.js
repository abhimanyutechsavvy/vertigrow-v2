import { readBody, clientIp, clip, bump, memLimit, foreignOrigin } from "./_store.js";

export const config = {
  runtime: "nodejs"
};

// cost protection: per-IP and whole-site limits on AI questions
const PER_IP_PER_MIN = 6;
const SITE_PER_DAY = 300;
const MAX_MESSAGE = 500;

// only plain numbers / short text from the browser go into the prompt
const n = v => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const t = (v, len = 20) => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").slice(0, len) : null);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ reply: "Use POST" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(200).json({ reply: "AI NOT CONFIGURED" });
    }

    if (foreignOrigin(req)) return res.status(403).json({ reply: "Forbidden" });

    const ip = clientIp(req);
    if (!memLimit("ai:" + ip, PER_IP_PER_MIN, 60000)) {
      return res.status(200).json({ reply: "Too many questions at once. Wait a minute and ask again." });
    }
    try {
      const [ipCount, dayCount] = await Promise.all([
        bump("vg:ai:ip:" + ip, 60),
        bump("vg:ai:day", 86400)
      ]);
      if (ipCount > PER_IP_PER_MIN) {
        return res.status(200).json({ reply: "Too many questions at once. Wait a minute and ask again." });
      }
      if (dayCount > SITE_PER_DAY) {
        return res.status(200).json({ reply: "The assistant has answered a lot of questions today. Try again tomorrow." });
      }
    } catch (e) {
      // database hiccup: the per-instance limit above still applies
    }

    const body = readBody(req);
    const message = typeof body.message === "string" && body.message.trim()
      ? body.message.slice(0, MAX_MESSAGE)
      : "hi";
    const sd = body.sensorData && typeof body.sensorData === "object" ? body.sensorData : {};

    const ph = n(sd.ph) ?? t(sd.ph) ?? "unknown";
    const tds = n(sd.tds) ?? t(sd.tds) ?? "unknown";
    const lvl = v => (n(v) === null ? "unknown" : n(v) + "%");
    const amt = (v, u) => (n(v) === null ? "unknown" : n(v) + " " + u);
    const mainLevel = lvl(sd.mainPct);
    const aLevel = lvl(sd.aPct);
    const bLevel = lvl(sd.bPct);
    const mode = sd.mode === "auto" || sd.mode === "manual" ? sd.mode : "unknown";
    const added = sd.addedTodayMl && typeof sd.addedTodayMl === "object" ? sd.addedTodayMl : {};
    const loc = sd.location && typeof sd.location === "object" ? sd.location : null;
    const where = loc
      ? `${clip(t(loc.place, 80) || "unknown", 80)}: ${n(loc.tempNow) ?? "?"}°C now, this week days about ${n(loc.dayMax) ?? "?"}°C and nights about ${n(loc.nightMin) ?? "?"}°C, about ${n(loc.rainMm) ?? 0} mm rain`
      : "not shared";

    const systemPrompt = `You are VertiGrow AI, an assistant for a vertical hydroponics garden.
Explain in very simple words.
Current system vitals:
- pH: ${ph}
- TDS: ${tds}
- Main water tank level: ${mainLevel}
- NPK A nutrient tank level: ${aLevel}
- NPK B nutrient tank level: ${bLevel}
- Water in main tank: ${amt(sd.mainL, "L")}
- NPK A left: ${amt(sd.aMl, "ml")}, NPK B left: ${amt(sd.bMl, "ml")}
- Nutrients added today: NPK A ${n(added.A) ?? 0} ml, NPK B ${n(added.B) ?? 0} ml
- Dosing mode: ${mode}
- User's location and local weather: ${where}
If the location is shared, tailor crop and care advice to that place and its weather.
If a tank is low, remind the user to refill it.
Rules:
- No wiring instructions
- No exact chemical quantities
- Keep answers short and friendly
- Only help with gardening, hydroponics and this VertiGrow system`;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        max_tokens: 300
      })
    });

    if (!aiRes.ok) {
      console.error("OPENAI STATUS:", aiRes.status);
      return res.status(200).json({ reply: "The assistant is unavailable right now. Try again in a minute." });
    }

    const data = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content || "No reply";
    return res.status(200).json({ reply });

  } catch (err) {
    console.error("AI ERROR:", err && err.message);
    return res.status(200).json({ reply: "The assistant is unavailable right now. Try again in a minute." });
  }
}
