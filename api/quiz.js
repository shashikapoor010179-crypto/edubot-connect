export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Two Groq keys, two separate accounts, randomly ordered per request so
  // load spreads ~50/50 instead of everyone hitting key 1 first.
  const KEY_A = process.env.GROQ_API_KEY_QUIZ;
  const KEY_B = process.env.GROQ_API_KEY_QUIZ_2;
  const [GROQ_PRIMARY, GROQ_SECONDARY] =
    KEY_B && Math.random() < 0.5 ? [KEY_B, KEY_A] : [KEY_A, KEY_B];

  // Gemini — genuinely separate provider, only touched if the primary Groq
  // attempt fails. Kept as a rare-case safety net, not extra capacity.
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GEMINI_API_KEY_2 = process.env.GEMINI_API_KEY_2;

  // Throws on any failure (network error, 429, non-2xx) so these can be
  // raced together with raceFirstSuccess() below — first one to resolve
  // successfully wins, instead of waiting through them one at a time.
  async function tryGroq(key) {
    if (!key) throw new Error("no-key");
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "llama-3.1-8b-instant", max_tokens: 1800, messages: req.body.messages }),
    });
    if (!r.ok) throw new Error("groq-failed-" + r.status);
    return r.json();
  }

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
    // Reshaped to look like Groq's response — same { choices:[{message:{content}}] }
    // shape — so nothing downstream needs to know which provider answered.
    return { choices: [{ message: { content: text } }] };
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
      // Fast path: primary Groq key alone (the common case — no need to
      // spend time/quota on anything else if this just works).
      data = await tryGroq(GROQ_PRIMARY);
    } catch (e1) {
      console.warn("Quiz: primary Groq key failed, racing fallback options");
      // Fallback: race the OTHER Groq key against Gemini key 1 in parallel
      // (instead of trying them one after another) — whichever answers
      // first wins, cutting worst-case wait roughly in half.
      const fallbackAttempts = [];
      if (GROQ_SECONDARY) fallbackAttempts.push(tryGroq(GROQ_SECONDARY));
      if (GEMINI_API_KEY) fallbackAttempts.push(tryGemini(GEMINI_API_KEY));
      try {
        data = await raceFirstSuccess(fallbackAttempts);
      } catch (e2) {
        // Last resort: Gemini key 2 alone.
        console.warn("Quiz: all first-round fallbacks failed, trying Gemini key 2");
        data = await tryGemini(GEMINI_API_KEY_2);
      }
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "All providers failed: " + err.message });
  }
}
