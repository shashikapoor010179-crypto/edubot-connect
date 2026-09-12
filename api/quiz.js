export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Gemini — two keys/accounts DEDICATED to quiz (separate from gcs.js's
  // Gemini keys).
  const GEMINI_API_KEY_QUIZ = process.env.GEMINI_API_KEY_QUIZ;
  const GEMINI_API_KEY_QUIZ_2 = process.env.GEMINI_API_KEY_QUIZ_2;

  // Groq — kept as fallback provider, not deleted.
  const GROQ_API_KEY_QUIZ = process.env.GROQ_API_KEY_QUIZ;
  const GROQ_API_KEY_QUIZ_2 = process.env.GROQ_API_KEY_QUIZ_2;

  const PROVIDER_TIMEOUT_MS = 7000;

  function withTimeout(promise, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(label + "-timeout")), PROVIDER_TIMEOUT_MS)
      ),
    ]);
  }

  // Shared validity check — used for EVERY provider now, not just Gemini.
  // A 200 response with truncated/garbled/empty JSON must be treated as a
  // failure so raceFirstSuccess moves on to another provider, instead of
  // handing broken data to the frontend and calling it a win.
  function assertUsableQuizJSON(text, label) {
    const cleaned = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn(label + ": not valid JSON. text length:", text.length);
      throw new Error(label + "-bad-json");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.warn(label + ": JSON parsed but empty/not an array. text length:", text.length);
      throw new Error(label + "-empty-json");
    }
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
    body.generationConfig = { maxOutputTokens: 4096 };

    // gemini-3.1-flash-lite-preview went GA in May 2026 and Google retires
    // preview endpoints shortly after that — this was almost certainly
    // returning an error on every call. Using the stable GA model name now.
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!r.ok) throw new Error(label + "-failed-" + r.status);
    const gData = await r.json();
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    assertUsableQuizJSON(text, label);
    return { choices: [{ message: { content: text } }] };
  }

  async function tryGroq(key, label) {
    if (!key) throw new Error(label + "-no-key");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        max_tokens: 3000,
        // gpt-oss is a REASONING model — without this it can burn most of
        // max_tokens on hidden "thinking" before ever writing the JSON,
        // truncating the actual answer. Low keeps reasoning minimal for a
        // simple structured-output task like this.
        reasoning_effort: "low",
        messages: req.body.messages,
      }),
    });
    if (!r.ok) throw new Error(label + "-failed-" + r.status);
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || "";
    assertUsableQuizJSON(text, label);
    return data;
  }

  function raceFirstSuccess(promises) {
    return new Promise((resolve, reject) => {
      let remaining = promises.length;
      let lastError = new Error("all-failed");
      if (remaining === 0) return reject(lastError);
      promises.forEach((p) => {
        p.then(resolve).catch((err) => {
          console.warn("Quiz provider attempt failed:", err.message);
          lastError = err;
          remaining--;
          if (remaining === 0) reject(lastError);
        });
      });
    });
  }

  try {
    const attempts = [];
    if (GEMINI_API_KEY_QUIZ) attempts.push(withTimeout(tryGemini(GEMINI_API_KEY_QUIZ, "gemini-1"), "gemini-1"));
    if (GEMINI_API_KEY_QUIZ_2) attempts.push(withTimeout(tryGemini(GEMINI_API_KEY_QUIZ_2, "gemini-2"), "gemini-2"));
    if (GROQ_API_KEY_QUIZ) attempts.push(withTimeout(tryGroq(GROQ_API_KEY_QUIZ, "groq-1"), "groq-1"));
    if (GROQ_API_KEY_QUIZ_2) attempts.push(withTimeout(tryGroq(GROQ_API_KEY_QUIZ_2, "groq-2"), "groq-2"));

    const data = await raceFirstSuccess(attempts);
    return res.status(200).json(data);
  } catch (err) {
    console.warn("Quiz: every provider failed or timed out:", err.message);
    return res.status(500).json({ error: "All providers failed: " + err.message });
  }
}
