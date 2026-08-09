export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Gemini — now PRIMARY for GCS. Two keys/accounts DEDICATED to gcs
  // (separate from quiz.js's Gemini keys), randomly ordered per request so
  // load spreads ~50/50 instead of everyone hitting key 1 first.
  const KEY_A = process.env.GEMINI_API_KEY_GCS;
  const KEY_B = process.env.GEMINI_API_KEY_GCS_2;
  const [GEMINI_PRIMARY, GEMINI_SECONDARY] =
    KEY_B && Math.random() < 0.5 ? [KEY_B, KEY_A] : [KEY_A, KEY_B];

  // Groq — kept as FALLBACK, not deleted. Only used if both Gemini
  // attempts fail (e.g. daily free-tier limit hit).
  const GROQ_API_KEY_GCS = process.env.GROQ_API_KEY_GCS;
  const GROQ_API_KEY_GCS_2 = process.env.GROQ_API_KEY_GCS_2;

  const SHEET_URL =
    "https://script.google.com/macros/s/AKfycbx0VqdEm4VDdOhEorgPERbkYaz49hNymLQsQsD2mR07D-6AGkYYJVqeBZmHxPAS7Tj9/exec";

  async function tryGemini(key) {
    if (!key) throw new Error("no-key");
    let systemInstruction = "";
    const contents = [];
    for (const m of req.body.messages) {
      if (m.role === "system") systemInstruction += (systemInstruction ? "\n\n" : "") + m.content;
      else contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
    }
    const body = { contents };
    if (systemInstruction) body.system_instruction = { parts: [{ text: systemInstruction }] };

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!r.ok) throw new Error("gemini-failed-" + r.status);
    const gData = await r.json();
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    // Reshaped to look like Groq's response shape so the sheet-logging
    // code below doesn't need to know which provider answered.
    return { choices: [{ message: { content: text } }] };
  }

  async function tryGroq(key) {
    if (!key) throw new Error("no-key");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "llama-3.1-8b-instant", max_tokens: 800, messages: req.body.messages }),
    });
    if (!r.ok) throw new Error("groq-failed-" + r.status);
    return r.json();
  }

  // Runs several attempts in parallel, resolves with whichever succeeds
  // first. Only rejects if every attempt fails.
  function raceFirstSuccess(promises) {
    return new Promise((resolve, reject) => {
      let remaining = promises.length;
      let lastError = new Error("all-failed");
      if (remaining === 0) return reject(lastError);
      promises.forEach((p) => {
        p.then(resolve).catch((err) => {
          lastError = err;
          remaining--;
          if (remaining === 0) reject(lastError);
        });
      });
    });
  }

  try {
    let data;
    try {
      // Fast path: primary Gemini key alone.
      data = await tryGemini(GEMINI_PRIMARY);
    } catch (e1) {
      console.warn("GCS: primary Gemini key failed, racing fallback options");
      const fallbackAttempts = [];
      if (GEMINI_SECONDARY) fallbackAttempts.push(tryGemini(GEMINI_SECONDARY));
      if (GROQ_API_KEY_GCS) fallbackAttempts.push(tryGroq(GROQ_API_KEY_GCS));
      try {
        data = await raceFirstSuccess(fallbackAttempts);
      } catch (e2) {
        console.warn("GCS: all first-round fallbacks failed, trying Groq key 2");
        data = await tryGroq(GROQ_API_KEY_GCS_2);
      }
    }

    const reply = data.choices?.[0]?.message?.content || "";

    // Last user question
    const userMessages = req.body.messages.filter((m) => m.role === "user");
    const lastQuestion = userMessages.length
      ? userMessages[userMessages.length - 1].content
      : "";

    // School is fixed for this route — no need to sniff the system prompt
    const school = "Gurukul Convent School";

    // Student name from frontend (comes from the login step).
    // If they haven't logged in (Continue as Guest), leave this blank
    // rather than writing the literal word "Guest" into the sheet.
    const studentName = req.body.name && req.body.name !== "Guest" ? req.body.name : "";

    // Save to Google Sheet — only what we actually want logged.
    fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        school: school,
        question: lastQuestion,
        name: studentName,
      }),
    }).catch(console.error);

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}



