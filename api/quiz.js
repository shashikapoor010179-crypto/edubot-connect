export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Gemini — now PRIMARY. Two keys/accounts DEDICATED to quiz (separate
  // from gcs.js's Gemini keys), randomly ordered per request so load
  // spreads ~50/50 instead of everyone hitting key 1 first.
  const KEY_A = process.env.GEMINI_API_KEY_QUIZ;
  const KEY_B = process.env.GEMINI_API_KEY_QUIZ_2;
  const [GEMINI_PRIMARY, GEMINI_SECONDARY] =
    KEY_B && Math.random() < 0.5 ? [KEY_B, KEY_A] : [KEY_A, KEY_B];

  // Groq — kept as FALLBACK, not deleted. Only touched if both Gemini
  // attempts fail (e.g. Gemini's free-tier limit is hit for the day).
  const GROQ_API_KEY_QUIZ = process.env.GROQ_API_KEY_QUIZ;
  const GROQ_API_KEY_QUIZ_2 = process.env.GROQ_API_KEY_QUIZ_2;

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
    // Gemini 2.5 Flash spends part of its output budget on internal "thinking"
    // before writing the actual answer — both come out of the SAME token
    // budget. For a plain JSON-generation task like this, thinking adds no
    // value and can eat the whole budget on a longer request (e.g. 15
    // questions), leaving little/no room for the actual JSON — which comes
    // back as an empty or truncated response even though the call itself
    // "succeeded" (HTTP 200). Disabling it and raising the output cap fixes
    // that at the source, instead of just detecting the bad output after.
    body.generationConfig = {
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    };

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!r.ok) throw new Error("gemini-failed-" + r.status);
    const gData = await r.json();
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const finishReason = gData.candidates?.[0]?.finishReason;

    // Validate the response is actually parseable JSON before declaring
    // success. Without this check, a malformed Gemini reply (extra
    // commentary, truncated output, stray markdown fences) gets forwarded
    // to the client as a "successful" response. The client's JSON.parse
    // then fails and the user sees "Couldn't load questions" — while the
    // Groq fallback below never gets a chance to run, because as far as
    // this function is concerned Gemini "succeeded" (HTTP 200).
    const cleaned = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty-or-not-array");
    } catch {
      // Log WHY it failed (empty output, hit the token cap, safety block, etc.)
      // so this is diagnosable from Vercel logs instead of guesswork next time.
      console.warn("Gemini returned unusable output. finishReason:", finishReason, "| text length:", text.length);
      throw new Error("gemini-bad-json");
    }

    // Reshaped to look like Groq's response — same { choices:[{message:{content}}] }
    // shape — so nothing downstream needs to know which provider answered.
    return { choices: [{ message: { content: text } }] };
  }

  async function tryGroq(key) {
    if (!key) throw new Error("no-key");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "openai/gpt-oss-20b", max_tokens: 1800, messages: req.body.messages }),
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
      // Fast path: primary Gemini key alone (the common case).
      data = await tryGemini(GEMINI_PRIMARY);
    } catch (e1) {
      console.warn("Quiz: primary Gemini key failed, racing fallback options");
      // Fallback: race the OTHER Gemini key against Groq key 1 in parallel
      // — whichever answers first wins.
      const fallbackAttempts = [];
      if (GEMINI_SECONDARY) fallbackAttempts.push(tryGemini(GEMINI_SECONDARY));
      if (GROQ_API_KEY_QUIZ) fallbackAttempts.push(tryGroq(GROQ_API_KEY_QUIZ));
      try {
        data = await raceFirstSuccess(fallbackAttempts);
      } catch (e2) {
        // Last resort: Groq key 2 alone.
        console.warn("Quiz: all first-round fallbacks failed, trying Groq key 2");
        data = await tryGroq(GROQ_API_KEY_QUIZ_2);
      }
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "All providers failed: " + err.message });
  }
}
