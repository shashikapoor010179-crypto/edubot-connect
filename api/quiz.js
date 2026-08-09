export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Two keys for Quiz, on two separate Groq accounts — so their rate limits
  // stack instead of sharing one quota. Serverless functions don't share
  // memory between requests, so a real "counter" round-robin isn't reliable
  // here. Instead we randomly pick a starting key per request — across many
  // simultaneous requests this spreads load ~50/50 between both keys right
  // from the start, instead of everyone piling onto key 1 first.
  const KEY_A = process.env.GROQ_API_KEY_QUIZ;
  const KEY_B = process.env.GROQ_API_KEY_QUIZ_2;
  const [GROQ_API_KEY, GROQ_API_KEY_2] =
    KEY_B && Math.random() < 0.5 ? [KEY_B, KEY_A] : [KEY_A, KEY_B];

  // Gemini — genuinely separate provider, only used if BOTH Groq keys fail.
  // Not for extra speed/capacity, purely a safety net (e.g. a Groq outage).
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GEMINI_API_KEY_2 = process.env.GEMINI_API_KEY_2;

  async function callGroq(key) {
    return fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        max_tokens: 1800,
        messages: req.body.messages,
      }),
    });
  }

  // Converts our OpenAI-style messages into Gemini's format, then reshapes
  // the reply back into { choices:[{message:{content}}] } — same shape Groq
  // returns — so nothing downstream needs to know which provider answered.
  async function callGemini(key) {
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
    if (!r.ok) throw new Error("Gemini call failed: " + r.status);
    const gData = await r.json();
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { choices: [{ message: { content: text } }] };
  }

  try {
    let response = await callGroq(GROQ_API_KEY);

    if (response.status === 429 && GROQ_API_KEY_2) {
      console.warn("Quiz: chosen Groq key rate-limited, retrying with other key");
      response = await callGroq(GROQ_API_KEY_2);
    }

    let data;
    if (response.status === 429 || !response.ok) {
      data = null;
      if (GEMINI_API_KEY) {
        try {
          console.warn("Quiz: both Groq keys unavailable, falling back to Gemini key 1");
          data = await callGemini(GEMINI_API_KEY);
        } catch (e) { console.warn("Quiz: Gemini key 1 failed:", e.message); }
      }
      if (!data && GEMINI_API_KEY_2) {
        try {
          console.warn("Quiz: trying Gemini key 2");
          data = await callGemini(GEMINI_API_KEY_2);
        } catch (e) { console.warn("Quiz: Gemini key 2 failed:", e.message); }
      }
      if (!data) data = await response.json(); // last resort — return whatever Groq gave us
    } else {
      data = await response.json();
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

