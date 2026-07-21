// Slide navigation between stories of the row/grid the user opened the
// detail surface from (_plans/2026-07-04-slide-between-row-stories.md).
//
// Every public surface (homepage rails, Browse/Search, Today's Verdicts,
// My List, More Like This) computes its ordered story list client-side and
// opens the detail surface through the shell-level `onOpen(id)` call. The
// surface passes its EXACT visible list along with the id as a SlideContext,
// and the detail surface (mobile TitleSheet / desktop DetailModal) navigates
// prev/next within that snapshot — so the slide order always matches what
// the user was looking at, including any active category filter on Browse.
//
// Deliberately a snapshot, not a live query: re-deriving the list inside the
// modal would couple it to every surface's derivation logic (curation rails,
// pill filters, the personalized continue rail, Saved storage) and could
// diverge from what the user actually saw. Deep links (`?story=X`) carry no
// context, so the controls hide for shared-link visitors — correct, they
// never saw a row.

export interface SlideContext {
  /** Ordered story ids exactly as the source surface rendered them. */
  ids: string[];
  /** The surface's on-screen title ("Top 10 Today", "Browse", "My List"…),
   *  shown in the position chip so the user knows what they're flipping
   *  through. */
  label: string;
}

export interface SlidePosition {
  /** Zero-based index of the current story within the context. */
  index: number;
  total: number;
}

/** Minimum horizontal travel before a touch gesture counts as a slide
 *  swipe. Slightly above the Billboard's 50px — the detail sheet scrolls
 *  vertically, so diagonal flicks mid-scroll need a higher bar. */
export const SLIDE_SWIPE_THRESHOLD_PX = 60;

/** How strongly horizontal the gesture must be (|dx| vs |dy|) to count.
 *  The Billboard only rejects vertical-DOMINANT gestures; the sheet is a
 *  long vertical scroller, so we demand clear horizontal intent instead. */
const SLIDE_SWIPE_DOMINANCE = 1.2;

/** Where the current story sits inside its slide context, or null when
 *  there is nothing to slide to: no context (deep link), a single-item
 *  list, or an id that's not in the snapshot (e.g. the context came from
 *  More Like This and the user kept drilling). Callers hide the controls
 *  entirely on null. */
export function slidePosition(
  ctx: SlideContext | null | undefined,
  currentId: string,
): SlidePosition | null {
  if (!ctx || ctx.ids.length < 2) return null;
  const index = ctx.ids.indexOf(currentId);
  if (index === -1) return null;
  return { index, total: ctx.ids.length };
}

/** The story id one step away in the context, wrapping at both ends
 *  (story 1 slides back to story N, story N slides forward to story 1 —
 *  explicit product requirement). dir 1 = next, -1 = previous. Null when
 *  the context isn't slidable. */
export function slideTarget(
  ctx: SlideContext | null | undefined,
  currentId: string,
  dir: -1 | 1,
): string | null {
  const pos = slidePosition(ctx, currentId);
  if (!pos || !ctx) return null;
  return ctx.ids[(pos.index + dir + pos.total) % pos.total];
}

/** Classify a completed touch gesture. Returns the slide direction
 *  (swipe left = advance = 1, swipe right = back = -1) or null for taps,
 *  scrolls, and diagonal flicks that don't clear the horizontal bar. */
export function resolveSwipeDirection(dx: number, dy: number): -1 | 1 | null {
  if (Math.abs(dx) < SLIDE_SWIPE_THRESHOLD_PX) return null;
  if (Math.abs(dx) < Math.abs(dy) * SLIDE_SWIPE_DOMINANCE) return null;
  return dx < 0 ? 1 : -1;
}

/** True when a touch that started on `target` must NOT be interpreted as
 *  a slide swipe: inside the video player (scrubbing), a text input, or
 *  any horizontally scrollable element (tab strip, More Like This rail,
 *  gallery) between the target and `boundary`. Walks up the tree so the
 *  detail surface can attach one handler at its root. */
export function isSlideSwipeExempt(
  target: EventTarget | null,
  boundary: HTMLElement | null,
): boolean {
  let el: HTMLElement | null = target instanceof HTMLElement ? target : null;
  while (el && el !== boundary) {
    const tag = el.tagName;
    if (tag === "VIDEO" || tag === "INPUT" || tag === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    // A real horizontal scroller has overflow to scroll through; the +4
    // slack keeps sub-pixel rounding from flagging ordinary blocks.
    if (el.scrollWidth > el.clientWidth + 4) return true;
    el = el.parentElement;
  }
  return false;
}

/** True when a keydown landed on an element that owns its own arrow-key
 *  behavior (text fields, selects, the video player) — the desktop modal
 *  skips slide navigation for those so typing and seeking stay intact. */
export function isSlideKeyExempt(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "VIDEO") {
    return true;
  }
  return target.isContentEditable;
}
