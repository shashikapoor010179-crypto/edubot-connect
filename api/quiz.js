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
  // If you only have one key, leave GROQ_API_KEY_QUIZ_2 unset and this will
  // just always use the first key.
  const KEY_A = process.env.GROQ_API_KEY_QUIZ; // ← Quizzes use their own keys
  const KEY_B = process.env.GROQ_API_KEY_QUIZ_2;
  const [GROQ_API_KEY, GROQ_API_KEY_2] =
    KEY_B && Math.random() < 0.5 ? [KEY_B, KEY_A] : [KEY_A, KEY_B];

  // Calls Groq with a given key. Returns the raw fetch Response so the
  // caller can check response.status (e.g. 429 = rate limited).
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

  try {
    let response = await callGroq(GROQ_API_KEY);

    // If the chosen key is rate-limited and we have a second key, retry once.
    if (response.status === 429 && GROQ_API_KEY_2) {
      console.warn("Quiz: chosen Groq key rate-limited, retrying with other key");
      response = await callGroq(GROQ_API_KEY_2);
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

