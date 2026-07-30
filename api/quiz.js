export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Two keys for Quiz — the second acts as a fallback when the first is
  // rate-limited (Groq returns HTTP 429). If you only have one key, leave
  // GROQ_API_KEY_QUIZ_2 unset in Vercel and this will just use the first key.
  const GROQ_API_KEY = process.env.GROQ_API_KEY_QUIZ; // ← Quizzes use their own key
  const GROQ_API_KEY_2 = process.env.GROQ_API_KEY_QUIZ_2;

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

    // If the first key is rate-limited and we have a second key, retry once.
    if (response.status === 429 && GROQ_API_KEY_2) {
      console.warn("Quiz: primary Groq key rate-limited, retrying with second key");
      response = await callGroq(GROQ_API_KEY_2);
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

