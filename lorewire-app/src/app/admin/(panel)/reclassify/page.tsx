import { requireCapability } from "@/lib/dal";
import { ReclassifyDryRunButton } from "./ReclassifyDryRunButton";

// Classifying the whole library calls the model once per story, so allow a
// longer function budget than the Vercel default.
export const maxDuration = 300;

export default async function ReclassifyPreviewPage() {
  await requireCapability("content.manage");
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div>
        <h1 className="font-display text-[20px] font-bold text-ink">
          Category reclassification
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          Preview how the new multi-tag categories would classify the story
          library before anything is applied. The dry-run writes nothing;
          applying the tags is a separate, gated pipeline step. Use the
          coverage numbers to decide whether the categories fit — a large
          review queue means a category is probably missing.
        </p>
      </div>
      <ReclassifyDryRunButton />
    </div>
  );
}
