export const config = {
  runtime: "nodejs"
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ reply: "Use POST" });
    }

    console.log("API KEY EXISTS:", !!process.env.OPENAI_API_KEY);

    if (!process.env.OPENAI_API_KEY) {
      return res.status(200).json({ reply: "AI NOT CONFIGURED" });
    }

    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message : "hi";
    const sensorData = typeof body.sensorData === "object" ? body.sensorData : {};
    const ph = sensorData.ph ?? "unknown";
    const tds = sensorData.tds ?? "unknown";
    const lvl = v => (v === null || v === undefined ? "unknown" : v + "%");
    const mainLevel = lvl(sensorData.mainPct);
    const aLevel = lvl(sensorData.aPct);
    const bLevel = lvl(sensorData.bPct);
    const mode = sensorData.mode ?? "unknown";
    const amt = (v, u) => (v === null || v === undefined ? "unknown" : v + " " + u);
    const added = sensorData.addedTodayMl || {};

    const systemPrompt = `You are VertiGrow AI, an assistant for a vertical hydroponics garden.
Explain in very simple words.
Current system vitals:
- pH: ${ph}
- TDS: ${tds}
- Main water tank level: ${mainLevel}
- NPK A nutrient tank level: ${aLevel}
- NPK B nutrient tank level: ${bLevel}
- Water in main tank: ${amt(sensorData.mainL, "L")}
- NPK A left: ${amt(sensorData.aMl, "ml")}, NPK B left: ${amt(sensorData.bMl, "ml")}
- Nutrients added today: NPK A ${added.A ?? 0} ml, NPK B ${added.B ?? 0} ml
- Dosing mode: ${mode}
If a tank is low, remind the user to refill it.
Rules:
- No wiring instructions
- No exact chemical quantities
- Keep answers short and friendly`;

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

    console.log("OPENAI STATUS:", aiRes.status);

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("OPENAI ERROR:", errText);
      return res.status(200).json({ reply: "AI FAILED: " + aiRes.status });
    }

    const data = await aiRes.json();
    console.log("FULL RESPONSE:", JSON.stringify(data));

    const reply = data.choices?.[0]?.message?.content || "No reply";
    return res.status(200).json({ reply });

  } catch (err) {
    console.error("BACKEND ERROR:", err);
    return res.status(200).json({ reply: "SERVER ERROR: " + err.message });
  }
}
