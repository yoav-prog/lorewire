"""Shared resolver for the burnt-in question end card.

The burnt-in card lives on the tail of every video render whose
underlying story has an enabled poll. Both render pipelines call into
this module so the long-form video and the short produce identical
card / no-card decisions for the same settings:

  - pipeline.shorts_render.build_short_props (short, 9:16)
  - pipeline.video.generate_video           (long-form, 16:9 or 9:16)

Phase 3 of _plans/2026-06-17-engagement-polls.md, extended in the
2026-06-18 "every article must have all we developed here" pass so
the long-form video also carries the card.
"""
from __future__ import annotations

from pipeline import store

# Duration of the burnt-in question end card. 2500ms matches the plan
# §N3 budget and the on-site widget's reveal cadence. Mirrored on the
# TS side as QUESTION_CARD_DURATION_MS in
# lorewire-app/src/lib/polls-shared.ts so the Lane A re-render path
# (TS-only, bypasses this Python build) bakes cards with the same
# tail length. Keep the two values aligned.
QUESTION_CARD_MS = 2500


def resolve_card_ms() -> int:
    """Resolve the question-card duration from settings, with bounds.

    Default: QUESTION_CARD_MS (2500). Admin override key:
    `polls.endcard.duration_ms` — accepts an integer in [500, 10000].
    Sub-500ms barely registers as a hold; >10000ms is dead space. Any
    parse error or out-of-range value falls back to the default.
    """
    raw = store.get_setting("polls.endcard.duration_ms")
    if not raw:
        return QUESTION_CARD_MS
    try:
        v = int(raw.strip())
    except (TypeError, ValueError):
        return QUESTION_CARD_MS
    if 500 <= v <= 10000:
        return v
    return QUESTION_CARD_MS


def endcard_disabled_by_setting() -> bool:
    """Master switch — when `polls.endcard.enabled` is explicitly off,
    NO video carries a burnt-in card, even when the story has an
    enabled poll. Falsy values: "0", "false" (case-insensitive),
    "off", "no". Unset / blank / anything else = enabled.
    """
    raw = store.get_setting("polls.endcard.enabled")
    if raw is None:
        return False
    return raw.strip().lower() in ("0", "false", "off", "no")


def build_question_card(row: dict) -> dict | None:
    """Resolve the burnt-in question card for this story's render.

    Returns None when the story has no enabled poll OR the admin has
    flipped `polls.endcard.enabled` off via settings — the video then
    renders byte-identical to its pre-poll shape. Returns a dict
    shaped for the DoodleShort composition's `question_card` prop when
    a poll exists.

    `slug` falls back to the story id when stories.slug is null. The
    user lands on the same `/v/<slug>` reader either way; the URL is
    just less pretty without a slug. Better than no link.
    """
    story_id = row.get("id")
    if not story_id:
        return None
    # Master switch first so the poll fetch is skipped when the card
    # is disabled — no point reading the row just to throw it away.
    if endcard_disabled_by_setting():
        return None
    poll = store.fetch_enabled_poll_for_story(story_id)
    if not poll:
        return None
    question = (poll.get("question") or "").strip()
    option_a = (poll.get("option_a_text") or "").strip()
    option_b = (poll.get("option_b_text") or "").strip()
    if not question or not option_a or not option_b:
        # The TS save action enforces non-empty fields, so this
        # should never trigger on a healthy row. Defense in depth
        # against a hand-edited DB or a partial migration — skipping
        # the card is preferable to a broken-looking render.
        print(
            f"[video id={story_id} poll] skipping question_card: "
            f"missing question or option text"
        )
        return None
    slug = (row.get("slug") or story_id).strip() or story_id
    return {
        "question": question,
        "option_a": option_a,
        "option_b": option_b,
        "slug": slug,
        "card_ms": resolve_card_ms(),
    }
