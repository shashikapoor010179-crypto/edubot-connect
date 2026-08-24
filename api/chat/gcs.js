export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Gemini — dedicated to GCS (separate from quiz.js's Gemini keys).
  const GEMINI_API_KEY_GCS = process.env.GEMINI_API_KEY_GCS;
  const GEMINI_API_KEY_GCS_2 = process.env.GEMINI_API_KEY_GCS_2; // may be undefined if only 1 Gemini key exists for GCS — handled gracefully below

  // Groq — kept as fallback, not deleted.
  const GROQ_API_KEY_GCS = process.env.GROQ_API_KEY_GCS;
  const GROQ_API_KEY_GCS_2 = process.env.GROQ_API_KEY_GCS_2;

  const SHEET_URL =
    "https://script.google.com/macros/s/AKfycbx0VqdEm4VDdOhEorgPERbkYaz49hNymLQsQsD2mR07D-6AGkYYJVqeBZmHxPAS7Tj9/exec";

  // Every provider attempt gets a hard per-call timeout. Without this, a
  // sequential "wait for one attempt to fail, THEN try the next" chain can
  // add up past Vercel's function execution window even if one of the
  // providers would have eventually succeeded — the whole request gets
  // killed with a 504, which looks identical to "Sorry, please try again!"
  // on the frontend.
  const PROVIDER_TIMEOUT_MS = 7000;

  function withTimeout(promise, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(label + "-timeout")), PROVIDER_TIMEOUT_MS)
      ),
    ]);
  }

  async function tryGemini(key, label) {
    if (!key) throw new Error(label + "-no-key");
    let systemInstruction = "";
    const contents = [];
    for (const m of req.body.messages) {
      if (m.role === "system") systemInstruction += (systemInstruction ? "\n\n" : "") + m.content;
      else contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
    }
    const body = { contents };
    if (systemInstruction) body.system_instruction = { parts: [{ text: systemInstruction }] };
    body.generationConfig = { maxOutputTokens: 2048 };

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!r.ok) throw new Error(label + "-failed-" + r.status);
    const gData = await r.json();
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // A 200 with empty text isn't a real success — don't let that count as
    // a win, or the student sees a blank/garbled reply instead of a retry.
    if (!text.trim()) {
      console.warn(label + ": Gemini returned empty text. finishReason:", gData.candidates?.[0]?.finishReason);
      throw new Error(label + "-empty-response");
    }

    // Reshaped to look like Groq's response shape so the sheet-logging
    // code below doesn't need to know which provider answered.
    return { choices: [{ message: { content: text } }] };
  }

  async function tryGroq(key, label) {
    if (!key) throw new Error(label + "-no-key");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-oss-20b", max_tokens: 800, messages: req.body.messages }),
    });
    if (!r.ok) throw new Error(label + "-failed-" + r.status);
    return r.json();
  }

  // Resolves with whichever attempt succeeds FIRST. Only rejects if every
  // attempt fails. Logs each individual failure as it happens, so Vercel
  // logs show exactly which provider failed and why.
  function raceFirstSuccess(promises) {
    return new Promise((resolve, reject) => {
      let remaining = promises.length;
      let lastError = new Error("all-failed");
      if (remaining === 0) return reject(lastError);
      promises.forEach((p) => {
        p.then(resolve).catch((err) => {
          console.warn("GCS provider attempt failed:", err.message);
          lastError = err;
          remaining--;
          if (remaining === 0) reject(lastError);
        });
      });
    });
  }

  try {
    // All available keys fire at once — not sequentially — each capped at
    // PROVIDER_TIMEOUT_MS, so one slow/dead provider can't drag the whole
    // request past the platform's execution limit.
    const attempts = [];
    if (GEMINI_API_KEY_GCS) attempts.push(withTimeout(tryGemini(GEMINI_API_KEY_GCS, "gemini-1"), "gemini-1"));
    if (GEMINI_API_KEY_GCS_2) attempts.push(withTimeout(tryGemini(GEMINI_API_KEY_GCS_2, "gemini-2"), "gemini-2"));
    if (GROQ_API_KEY_GCS) attempts.push(withTimeout(tryGroq(GROQ_API_KEY_GCS, "groq-1"), "groq-1"));
    if (GROQ_API_KEY_GCS_2) attempts.push(withTimeout(tryGroq(GROQ_API_KEY_GCS_2, "groq-2"), "groq-2"));

    const data = await raceFirstSuccess(attempts);
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
    console.warn("GCS: every provider failed or timed out:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
