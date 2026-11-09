# Lawyer / operator checklist

The items code cannot close. Each needs a human decision or a signature before
LoreWire is fully compliant. Grouped by urgency. Owner tags: `[legal]` needs
counsel, `[operator]` is an account/admin action.

## Do first (live site, real EU/UK users)

- [ ] `[operator]` Confirm the **controller's legal entity name, registration
      number, and registered address**. It is a placeholder ("Flexelent") in
      `/privacy`, `/terms`, and this pack. A privacy policy without a real
      identifiable controller is itself a defect.
- [ ] `[legal]` Determine whether the controller has an **EU establishment**. If
      not, appoint an **Article 27 EU representative** (and a UK representative
      under the UK GDPR), and publish their contact details in `/privacy`.
- [ ] `[legal]` Define and document the **personal-data breach process**
      (detection, assessment, the 72-hour supervisory-authority notification
      under Art. 33, and data-subject notification under Art. 34). Name who is
      responsible.
- [ ] `[operator]` Confirm the **info@lorewire.com DSAR inbox is monitored** and
      that access/erasure requests are actioned within the 30-day clock
      (Art. 12(3)). Keep the existing `data_deletion_requests` audit trail.

## Content originality (added 2026-11-09)

Production facts as of 2026-11-09. LoreWire's stories were adapted from Reddit
posts and labeled "True Story" with links to the source threads. New stories now
use the premise-only process in `CONTENT_POLICY.md`. Older stories keep their
adapted text; only their label and links changed.

- 1,239 published stories, each with its Reddit post id in its public URL.
- Already posted: 302 to YouTube, 170 to Facebook, 165 to Instagram.
- Source pool: about 30,900 full-text Reddit posts held in the database.
- Autopilot generates up to 10 stories a day from that pool and can publish them
  without a person reviewing each one.

Questions for counsel:

- [ ] `[legal]` Copyright: are the published adaptations infringing derivative
      works under German law? Should they be rewritten, unlisted, or removed?
- [ ] `[legal]` Does a premise-only story avoid infringement when the premise is
      distinctive? German law can protect a sufficiently individual plot.
- [ ] `[legal]` Are the source links' removal and the new label a problem for
      adapted stories, given that credit was previously shown?
- [ ] `[legal]` UWG: were "True Story" and is "True stories from the internet"
      misleading for adapted and AI-written content? Is "Fictionalized story,
      inspired by real-life situations" adequate?
- [ ] `[legal]` Reddit's terms: exposure from how the pool was collected and from
      commercial use of it, including premises drawn from it by automation.
- [ ] `[legal]` GDPR: lawful basis, retention and erasure for strangers' posts in
      `reddit_source` and `story_sources`. Keep them as evidence, or purge?
- [ ] `[legal]` Personality rights of people described in source posts.
- [ ] `[legal]` Do EU AI-labeling duties apply to these videos and articles?
- [ ] `[legal]` Should posts already on social platforms be taken down or edited?
- [ ] `[operator]` Publish a takedown contact, once counsel confirms the process.
- [ ] `[operator]` Decide whether autopilot may keep selecting sources, since
      rule 6 of `CONTENT_POLICY.md` says sources are selected manually.

## Processor contracts and transfers (Art. 28, Chapter V)

- [ ] `[operator]` Obtain and counter-sign a **DPA with every processor** in
      `processors-and-transfers.md` (Neon, Vercel, Brevo, Google, Microsoft,
      Reddit, and the pipeline vendors).
- [ ] `[legal]` For each **US-located processor** handling public-user data,
      record the transfer mechanism (EU-US Data Privacy Framework certification
      or SCCs plus a transfer risk assessment).
- [ ] `[operator]` Consider provisioning **Neon in an EU region** to remove the
      largest user-data transfer.
- [ ] `[operator]` Run diligence on the **least-known vendors** (Kie.ai, Decodo):
      confirm what they receive, where, and on what terms.

## Policy and lawful basis

- [ ] `[legal]` Review the **lawful-basis register** in
      `records-of-processing.md`, especially the **legitimate-interests
      balancing test** for poll abuse-prevention (the IP+UA hash) and the
      consent basis for reader-activity storage.
- [ ] `[legal]` Sign off on the **DPIA screening** (`dpia-screening.md`) or
      commission a full DPIA.
- [ ] `[legal]` Confirm the **governing law** in `/terms` (currently a TODO
      reading "State of Israel") and that it is consistent with serving EU/UK
      consumers.
- [ ] `[legal]` Confirm the **cookie / ePrivacy** stance: LoreWire uses only
      first-party functional cookies and shows an Accept/Reject banner. Strictly
      necessary cookies need no consent; confirm the functional reader-activity
      storage is correctly handled by the existing consent banner.
- [ ] `[legal]` Assess any **residual exposure from data collected under the
      prior privacy policy** (which, before the 2026-06-22 correction, described
      a deletion control that did not exist and miscounted cookies). Forward
      correction does not by itself cure past processing.

## Already addressed in code (verify, don't rebuild)

- [x] Privacy policy and Terms corrected to match reality (commit `e0c861d`).
- [x] Canonical erasure path with an audit trail (`account-deletion.ts`,
      `data_deletion_requests`) — owned by the data-deletion work.
- [x] Self-serve data export endpoint (`/api/user/export`), Art. 15/20.
- [x] The **24h IP+UA hash prune** is live (the `/api/polls/refresh` cron calls
      `pruneOldIpUaHashes`). Verified.
- [x] The **magic-link token expiry prune** is wired to an hourly cron
      (`/api/prune_magic_links` calling `pruneExpiredMagicLinks`). Shipped.
- [x] The **recently-viewed 50-row cap** needs no action today: the
      `user_recently_viewed` table has no server-side write path yet
      (recently-viewed is localStorage-only), so nothing accumulates. Implement
      the cap when/if a server-side write lands.
- [~] `[operator]` Largely covered: the hourly magic-link prune removes a
      deleted account's leftover tokens within ~1 hour of their 15-minute
      expiry. Adding an explicit `magic_link_tokens` wipe to
      `deleteUserCompletely` would make erasure immediate (defense in depth) —
      a small, optional improvement for the deletion owner.
