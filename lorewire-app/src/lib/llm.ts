// Provider-agnostic chat-completion call. Picks the right endpoint + auth
// from the model id prefix. Mirrors the registry shape in data/models.json:
//
//   openai/<model>   → api.openai.com/v1/chat/completions, OPENAI_API_KEY
//   kie/<model>      → not wired yet (kie.ai's LLM gateway is on the
//                      roadmap; today the registry marks these wired:false)
//   anthropic/<model> → not wired (no ANTHROPIC_API_KEY in env at the moment)
//
// Returns a discriminated union so callers can branch on success/failure
// without try/catch wrappers. Errors are normalized to a short string —
// upstream status + first 300 chars of the body, never the API key.
//
// Security (rule 13): credentials read from env only. API keys never
// appear in the returned error string even on upstream non-OK responses.
// requireAdmin gates every entry point that lands here.

import "server-only";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatResult =
  | { ok: true; content: string; provider: string; model: string }
  | { ok: false; error: string };

interface ChatOpts {
  modelId: string;
  messages: ChatMessage[];
  /** Force the response to be valid JSON (provider-side schema enforcement
   *  on OpenAI; downstream JSON.parse on the caller side). */
  jsonMode?: boolean;
  /** 0–2, defaults to 0.7. Lower = more deterministic. */
  temperature?: number;
}

export async function chatCompletion(opts: ChatOpts): Promise<ChatResult> {
  const [provider, ...rest] = opts.modelId.split("/");
  const model = rest.join("/");
  if (!provider || !model) {
    return {
      ok: false,
      error: `Invalid model id "${opts.modelId}" — expected "provider/model"`,
    };
  }

  if (provider === "openai") {
    return openaiChat(model, opts);
  }
  if (provider === "kie") {
    return {
      ok: false,
      error:
        "kie.ai LLM models are not wired on the Node side yet. Pick an OpenAI model in Settings → Models, or wire kie.ai's chat endpoint.",
    };
  }
  if (provider === "anthropic") {
    return {
      ok: false,
      error: "Anthropic models are not wired (no ANTHROPIC_API_KEY in env).",
    };
  }
  return { ok: false, error: `Unknown provider "${provider}"` };
}

async function openaiChat(model: string, opts: ChatOpts): Promise<ChatResult> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    return { ok: false, error: "OPENAI_API_KEY not configured" };
  }
  try {
    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
    };
    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      const errBody = (await r.text()).slice(0, 300);
      console.warn("[llm openai] non-ok", { status: r.status, model });
      return { ok: false, error: `OpenAI ${r.status}: ${errBody}` };
    }
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data?.choices?.[0]?.message?.content ?? "";
    if (!content) {
      return { ok: false, error: "OpenAI returned empty content" };
    }
    console.info("[llm openai] ok", { model, chars: content.length });
    return { ok: true, content, provider: "openai", model };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `OpenAI call failed: ${msg}` };
  }
}
