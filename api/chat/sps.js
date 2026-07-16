export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Two keys for SPS — the second acts as a fallback when the first is
  // rate-limited (Groq returns HTTP 429). If you only have one key, leave
  // GROQ_API_KEY_SPS_2 unset in Vercel and this will just use the first key.
  const GROQ_API_KEY = process.env.GROQ_API_KEY_SPS;
  const GROQ_API_KEY_2 = process.env.GROQ_API_KEY_SPS_2;
  const SHEET_URL =
    "https://script.google.com/macros/s/AKfycbx0VqdEm4VDdOhEorgPERbkYaz49hNymLQsQsD2mR07D-6AGkYYJVqeBZmHxPAS7Tj9/exec";

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
        max_tokens: 800,
        messages: req.body.messages,
      }),
    });
  }

  try {
    let response = await callGroq(GROQ_API_KEY);

    // If the first key is rate-limited and we have a second key, retry once.
    if (response.status === 429 && GROQ_API_KEY_2) {
      console.warn("SPS: primary Groq key rate-limited, retrying with second key");
      response = await callGroq(GROQ_API_KEY_2);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "";

    const userMessages = req.body.messages.filter((m) => m.role === "user");
    const lastQuestion = userMessages.length
      ? userMessages[userMessages.length - 1].content
      : "";

    const school = "Siddharth Public School";

    // Student name from frontend (comes from the login step).
    // If they haven't logged in (Continue as Guest), leave this blank
    // rather than writing the literal word "Guest" into the sheet.
    const studentName = req.body.name && req.body.name !== "Guest" ? req.body.name : "";

    // Save to Google Sheet — only what we actually want logged.
    // Timestamp is added by the Apps Script itself (new Date()) when the row
    // is written, so we don't need to send one from here.
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


