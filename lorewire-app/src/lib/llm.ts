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
  // ---- Reasoning-model (GPT-5 family) support. All optional; existing
  // callers pass none of these and get the exact same request as before. ----
  /** Strict Structured Outputs. Takes precedence over jsonMode. The model is
   *  forced to return exactly this JSON Schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** GPT-5 reasoning models expect `max_completion_tokens`, not `max_tokens`. */
  maxCompletionTokens?: number;
  /** GPT-5 reasoning effort. "minimal" is right for fast classification. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Reasoning models reject a non-default temperature; set this to leave the
   *  field off the request entirely. */
  omitTemperature?: boolean;
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
    return kieChat(model, opts);
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
  return openaiCompatibleChat({
    label: "openai",
    base: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    apiKeyEnvName: "OPENAI_API_KEY",
    model,
    opts,
  });
}

async function kieChat(model: string, opts: ChatOpts): Promise<ChatResult> {
  // kie.ai operates as a unified gateway with an OpenAI-compatible chat
  // completions endpoint. The image-side API at api.kie.ai/api/v1/jobs is
  // an async createTask pattern; the LLM gateway uses the OpenAI shape at
  // api.kie.ai/v1/chat/completions. KIE_BASE_URL can override if their
  // routing ever changes — fail with the upstream body verbatim so the
  // admin sees exactly what kie's server reported.
  return openaiCompatibleChat({
    label: "kie",
    base: process.env.KIE_BASE_URL?.trim() || "https://api.kie.ai/v1",
    apiKey: process.env.KIE_API_KEY?.trim() ?? "",
    apiKeyEnvName: "KIE_API_KEY",
    model,
    opts,
  });
}

interface OpenAICompatibleArgs {
  label: string;
  base: string;
  apiKey: string;
  apiKeyEnvName: string;
  model: string;
  opts: ChatOpts;
}

async function openaiCompatibleChat(
  args: OpenAICompatibleArgs,
): Promise<ChatResult> {
  if (!args.apiKey) {
    return { ok: false, error: `${args.apiKeyEnvName} not configured` };
  }
  try {
    const body: Record<string, unknown> = {
      model: args.model,
      messages: args.opts.messages,
    };
    if (!args.opts.omitTemperature) {
      body.temperature = args.opts.temperature ?? 0.7;
    }
    if (args.opts.maxCompletionTokens) {
      body.max_completion_tokens = args.opts.maxCompletionTokens;
    }
    if (args.opts.reasoningEffort) {
      body.reasoning_effort = args.opts.reasoningEffort;
    }
    if (args.opts.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: args.opts.jsonSchema.name,
          strict: true,
          schema: args.opts.jsonSchema.schema,
        },
      };
    } else if (args.opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    const url = `${args.base.replace(/\/$/, "")}/chat/completions`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      const errBody = (await r.text()).slice(0, 300);
      console.warn(`[llm ${args.label}] non-ok`, {
        status: r.status,
        model: args.model,
      });
      return {
        ok: false,
        error: `${args.label} ${r.status}: ${errBody}`,
      };
    }
    const data = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data?.choices?.[0]?.message?.content ?? "";
    if (!content) {
      return { ok: false, error: `${args.label} returned empty content` };
    }
    console.info(`[llm ${args.label}] ok`, {
      model: args.model,
      chars: content.length,
    });
    return { ok: true, content, provider: args.label, model: args.model };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${args.label} call failed: ${msg}` };
  }
}
