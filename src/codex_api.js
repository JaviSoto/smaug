const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

function getOutputText(responseJson) {
  if (typeof responseJson.output_text === 'string' && responseJson.output_text.trim()) {
    return responseJson.output_text;
  }

  const output = responseJson.output;
  if (!Array.isArray(output)) return null;

  for (const item of output) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }

  return null;
}

export async function callCodexJson({ model, reasoningEffort, schema, inputText, maxOutputTokens }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const timeoutMs = Number(process.env.SMAUG_OPENAI_TIMEOUT_MS || 300000); // 5 min default
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model,
    input: [
      { role: 'user', content: inputText },
    ],
    reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
    max_output_tokens: maxOutputTokens ?? 1800,
    text: {
      format: {
        type: 'json_schema',
        name: 'smaug_bookmark_processing',
        strict: true,
        schema,
      },
    },
  };

  let resp;
  try {
    resp = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`OpenAI Responses API timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || `HTTP ${resp.status}`;
    throw new Error(`OpenAI Responses API error: ${msg}`);
  }

  const text = getOutputText(data);
  if (!text) {
    throw new Error('OpenAI Responses API returned no output_text');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse model JSON output: ${e.message}`);
  }

  return { parsed, usage: data.usage };
}
