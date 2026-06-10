// Model registry + per-stage selection for the admin picker. The registry is
// static config (mirrored from /config/models.json); the active model for each
// stage is admin-set and stored in the settings table. No API keys here.

import "server-only";
import registry from "@/data/models.json";
import { getSetting, setSetting } from "@/lib/repo";

export type Stage = "llm" | "images" | "voice";

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  cost: string;
  wired: boolean;
}

interface StageDef {
  default: string;
  fallback?: string;
  options: ModelOption[];
}

const REG = registry as unknown as Record<string, StageDef>;

export const STAGES: Stage[] = ["llm", "images", "voice"];

export const STAGE_LABEL: Record<Stage, string> = {
  llm: "Writing (LLM)",
  images: "Illustration",
  voice: "Narration",
};

export function options(stage: Stage): ModelOption[] {
  return REG[stage]?.options ?? [];
}

export function defaultModel(stage: Stage): string {
  return REG[stage]?.default ?? "";
}

export function fallbackModel(stage: Stage): string | undefined {
  return REG[stage]?.fallback;
}

export async function selected(stage: Stage): Promise<string> {
  return (await getSetting(`model.${stage}`)) ?? defaultModel(stage);
}

export async function selectModel(stage: Stage, id: string): Promise<void> {
  const valid = new Set(options(stage).map((o) => o.id));
  if (!valid.has(id)) {
    throw new Error(`${id} is not a valid model for ${stage}`);
  }
  await setSetting(`model.${stage}`, id);
}

export async function allSelected(): Promise<Record<Stage, string>> {
  const out = {} as Record<Stage, string>;
  for (const s of STAGES) out[s] = await selected(s);
  return out;
}
