// Server endpoint for the "Auto-draft from story" button in the poll
// editor. Loads the story, prompts the active LLM (Settings → Models)
// with the body + category preset as voice guidance, and returns a
// slim JSON shape the client editor maps onto the question + option
// inputs.
//
// Cost (rule 8): a single chat-completion per click. With gpt-5.4-mini
// at typical story body lengths (~2-4K chars) this is well under
// $0.001 per call.
//
// Security (rule 13): admin-gated. Story id resolves to a real row
// before any LLM call so spamming the endpoint can't burn budget on
// garbage ids. Prompt template is fixed server-side; the user can't
// inject system instructions. LLM output is validated through the same
// validatePollInputs gate the save action uses — a model hallucinating
// over-length labels or identical sides is rejected the same way a
// bad admin form submission is.
//
// Plan: _plans/2026-06-17-engagement-polls.md (Phase 1, F2).

import { NextRequest } from "next/server";
import { requireCapability } from "@/lib/dal";
import { getStory } from "@/lib/repo";
import { selected } from "@/lib/models";
import { chatCompletion } from "@/lib/llm";
import {
  getPresetForCategory,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  validatePollInputs,
} from "@/lib/polls";

interface SuggestPayload {
  question: string;
  optionA: string;
  optionB: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  await requireCapability("content.manage");
  let body: { storyId?: string };
  try {
    body = (await req.json()) as { storyId?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const storyId = body.storyId?.trim();
  if (!storyId) {
    return Response.json({ error: "storyId required" }, { status: 400 });
  }

  const story = await getStory(storyId);
  if (!story) {
    return Response.json({ error: "Story not found" }, { status: 404 });
  }

  const modelId = await selected("llm");
  const preset = getPresetForCategory(story.category);
  // Cap the body at 4000 chars: enough context for the model to pick
  // the right two sides, cheap enough that the call stays under a
  // penny. Longer bodies are tail-cut, not summarised — the LLM only
  // needs the setup, not the resolution.
  const bodyText = (story.body ?? "").slice(0, 4000);

  const result = await chatCompletion({
    modelId,
    jsonMode: true,
    temperature: 0.5,
    messages: [
      {
        role: "system",
        content: [
          "You write engagement polls for Lorewire stories.",
          "Output strict JSON only, no prose, no markdown fences.",
          "Voice: short, emotional, opinionated — the question should",
          "make someone want to vote without reading the story twice.",
          "Avoid neutral framings. Avoid 'I think' or 'maybe'.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Story title: ${story.title ?? ""}`,
          `Story category: ${story.category ?? "Drama"}`,
          `Preset style for this category — question: "${preset.question}"; options: "${preset.optionA}" vs "${preset.optionB}". Match this energy.`,
          "",
          "Story body:",
          bodyText,
          "",
          "Return strict JSON with these keys:",
          `- question: string, max ${POLL_QUESTION_MAX} characters, ends with a question mark.`,
          `- optionA: string, max ${POLL_OPTION_MAX} characters — one of the two sides.`,
          `- optionB: string, max ${POLL_OPTION_MAX} characters — the other side.`,
          "Side labels must be the actual characters or positions in the story (eg 'Wife' / 'Husband', 'Yes' / 'No') — not 'Option A' / 'Option B'.",
        ].join("\n"),
      },
    ],
  });

  if (!result.ok) {
    console.warn("[polls suggest] llm failed", {
      story_id: storyId,
      model: modelId,
      error: result.error.slice(0, 200),
    });
    return Response.json({ error: result.error }, { status: 502 });
  }

  let parsed: Partial<SuggestPayload>;
  try {
    parsed = JSON.parse(result.content) as Partial<SuggestPayload>;
  } catch {
    console.warn("[polls suggest] non-json response", {
      story_id: storyId,
      model: modelId,
      preview: result.content.slice(0, 200),
    });
    return Response.json(
      { error: "Model returned non-JSON output. Try again or pick a different model." },
      { status: 502 },
    );
  }

  // Re-use the editor's validation gate so LLM output is held to the
  // same contract as admin form input — over-length labels, identical
  // sides, or empties get rejected here, not at write time.
  const validated = validatePollInputs({
    question: parsed.question,
    optionA: parsed.optionA,
    optionB: parsed.optionB,
  });
  if (!validated.ok) {
    console.warn("[polls suggest] llm output rejected", {
      story_id: storyId,
      model: modelId,
      error: validated.error,
    });
    return Response.json(
      { error: `Model output didn't pass validation: ${validated.error}` },
      { status: 502 },
    );
  }

  console.info("[polls suggest] ok", {
    story_id: storyId,
    model: modelId,
    question_len: validated.cleaned.question.length,
  });

  return Response.json({
    suggestion: validated.cleaned,
    model: result.model,
    provider: result.provider,
  });
}
