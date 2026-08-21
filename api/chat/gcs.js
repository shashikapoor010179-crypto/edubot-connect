export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Gemini — PRIMARY for GCS. Single dedicated key.
  const GEMINI_API_KEY_GCS = process.env.GEMINI_API_KEY_GCS;

  // Groq — FALLBACK only, used if Gemini fails (e.g. free-tier limit hit).
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

    // gemini-2.5-flash retires Oct 16 2026 and has been flaky already.
    // gemini-3.5-flash-lite is the current free-tier workhorse.
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!r.ok) throw new Error("gemini-failed-" + r.status);
    const gData = await r.json();
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    // Reshaped to match Groq's response shape so the sheet-logging code
    // below doesn't need to know which provider answered.
    return { choices: [{ message: { content: text } }] };
  }

  async function tryGroq(key) {
    if (!key) throw new Error("no-key");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      // llama-3.1-8b-instant was shut down by Groq on Aug 16, 2026.
      // openai/gpt-oss-20b is Groq's official migration target.
      body: JSON.stringify({ model: "openai/gpt-oss-20b", max_tokens: 800, messages: req.body.messages }),
    });
    if (!r.ok) throw new Error("groq-failed-" + r.status);
    return r.json();
  }

  // Runs several attempts in parallel, resolves with whichever succeeds first.
  // Only rejects if every attempt fails.
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
      // Fast path: the single Gemini key.
      data = await tryGemini(GEMINI_API_KEY_GCS);
    } catch (e1) {
      console.warn("GCS: Gemini failed, racing both Groq keys as fallback");
      const fallbackAttempts = [];
      if (GROQ_API_KEY_GCS) fallbackAttempts.push(tryGroq(GROQ_API_KEY_GCS));
      if (GROQ_API_KEY_GCS_2) fallbackAttempts.push(tryGroq(GROQ_API_KEY_GCS_2));
      data = await raceFirstSuccess(fallbackAttempts);
    }

    const reply = data.choices?.[0]?.message?.content || "";

    const userMessages = req.body.messages.filter((m) => m.role === "user");
    const lastQuestion = userMessages.length
      ? userMessages[userMessages.length - 1].content
      : "";

    const school = "Gurukul Convent School";

    const studentName = req.body.name && req.body.name !== "Guest" ? req.body.name : "";

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

