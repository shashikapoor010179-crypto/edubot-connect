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

  // Every provider attempt gets a hard per-call timeout. Without this, one
  // slow/hanging provider can eat most of Vercel's total function execution
  // window all by itself — and on a Hobby-tier function budget, a SEQUENTIAL
  // chain of "wait for Gemini to fail, THEN wait for the next attempt, THEN
  // wait for the one after that" can add up past the limit even if every
  // individual call would have eventually succeeded on its own. Vercel then
  // kills the whole function with a 504, which looks identical to "all
  // providers failed" on the client — even though, given enough time, one of
  // them may well have returned a good answer.
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
    body.generationConfig = {
      maxOutputTokens: 4096
      // No thinkingConfig here. The 2.5 series used `thinking_budget` to
      // control reasoning; the 3.x series uses a different field
      // (`thinking_level`) instead. gemini-3.1-flash-lite-preview doesn't
      // reason by default for a plain JSON-generation task like this, so
      // there's nothing extra to disable — sending the old 2.5-style field
      // here could itself trigger a 400 on this model.
    };

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!r.ok) throw new Error(label + "-failed-" + r.status);
    const gData = await r.json();
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const finishReason = gData.candidates?.[0]?.finishReason;

    // Validate the response is actually parseable JSON before declaring
    // success — a 200 with empty/garbled text should NOT count as a win.
    const cleaned = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty-or-not-array");
    } catch {
      console.warn(label + ": unusable output. finishReason:", finishReason, "| text length:", text.length);
      throw new Error(label + "-bad-json");
    }

    // Reshaped to look like Groq's response — same { choices:[{message:{content}}] }
    // shape — so nothing downstream needs to know which provider answered.
    return { choices: [{ message: { content: text } }] };
  }

  async function tryGroq(key, label) {
    if (!key) throw new Error(label + "-no-key");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-oss-20b", max_tokens: 1800, messages: req.body.messages }),
    });
    if (!r.ok) throw new Error(label + "-failed-" + r.status);
    return r.json();
  }

  // Resolves with whichever attempt succeeds FIRST. Only rejects if every
  // single attempt fails. Logs each individual failure as it happens so
  // Vercel logs show exactly which providers failed and why, not just the
  // final aggregate outcome.
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
    // ALL FOUR attempts fire at once, right from the start — not
    // sequentially. Whichever provider answers first (with a valid result)
    // wins. Every attempt is individually capped at PROVIDER_TIMEOUT_MS, so a
    // single slow/hanging provider can never drag the whole request past
    // Vercel's function execution limit. This replaces the previous
    // "try Gemini, THEN wait and try the next set, THEN wait and try the
    // last resort" waterfall, whose cumulative wait time across multiple
    // slow failures could exceed the platform's timeout even when a working
    // provider existed somewhere in the chain.
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
