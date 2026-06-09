exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  const { system, messages } = JSON.parse(event.body);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer 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' },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', max_tokens: 800, messages: [{ role: 'system', content: system }, ...messages] })
  });
  const data = await res.json();
  return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ reply: data.choices?.[0]?.message?.content || 'Sorry, try again!' }) };
};
