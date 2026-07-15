export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY_SPS; // ← SPS uses its own key
  const SHEET_URL =
    "https://script.google.com/macros/s/AKfycbzkjMmVFS3PsiggU_GJ5q67QIItnkwFRQl-P1lA4bBjP2DnqeV6TmN_fFDS-JjiSKKl/exec";

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 800,
          messages: req.body.messages,
        }),
      }
    );

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "";

    const userMessages = req.body.messages.filter((m) => m.role === "user");
    const lastQuestion = userMessages.length
      ? userMessages[userMessages.length - 1].content
      : "";

    const school = "Siddharth Public School";

    const studentName = req.body.name || "Guest";

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
