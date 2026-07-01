# Imprint page + GDPR privacy alignment to Traffic.Club IT GmbH

Date: 2026-07-01
Branch: feat/render-publish-schedulers (working tree; will surface for its own commit/PR)

## Goal

1. Add a public **Imprint** (Impressum) page for LoreWire, carrying the legal
   details of the operating company Traffic.Club IT GmbH.
2. Bring LoreWire's Privacy Policy and Terms into line with that operator:
   name the company as data controller / operator, and add the GDPR framing
   that the sister site yoursportspot.com already has and we were missing.

## Context / what triggered this

- User supplied the imprint details for **Traffic.Club IT GmbH**
  (Kaiserstrasse 170-174, 66386 St. Ingbert, Germany; eMail office@fireball.com;
  Management Gaelle Lallement, Rolf Rosskopf; Commercial Register HRB 19295,
  Saarbruecken; VAT DE266854381).
- User asked to compare our Privacy Policy against
  https://yoursportspot.com/privacy_policy/ and add what we lack.
- Key finding: yoursportspot.com's **data controller is the same
  Traffic.Club IT GmbH**. So yoursportspot is a sister site under the same
  operator, and LoreWire is being aligned to that corporate entity.

## Decisions (confirmed with user 2026-07-01)

- **Operator scope: full align to the GmbH.** Traffic.Club IT GmbH is the
  legal operator. Update Imprint + Privacy + Terms, add full GDPR framing,
  and change Terms governing law from Israel to Germany.
- **Imprint contact email: office@fireball.com**, reproduced exactly as given.

## Deliberately NOT copied from yoursportspot

yoursportspot is ad-supported; large parts of its policy exist to disclose
third-party advertising and tracking (Google AdSense, Google Ads, VWO A/B
testing, Cookiebot, Google Tag Manager, web beacons). LoreWire's policy
explicitly states it runs NO advertising and NO third-party ad/marketing
tags. Copying those disclosures would describe data flows that do not happen,
which is itself a compliance defect. Excluded on purpose. If LoreWire ever
runs ads under Traffic.Club, that is a separate change (code + policy).

## Genuinely missing GDPR items being added to Privacy

1. Named data controller identity + link to Imprint (Section "Who we are").
2. Legal bases for processing per GDPR Art. 6 (new dedicated section):
   contract (Art. 6(1)(b)), legitimate interests (f), consent (a) for
   analytics, legal obligation (c).
3. Statement of no automated decision-making / profiling with legal effect
   (Art. 22), noting AI content generation is not a decision about the user.
4. Expanded data-subject rights: restriction (Art. 18), objection (Art. 21),
   data portability (Art. 20), withdraw consent (Art. 7).
5. Right to lodge a complaint with a supervisory authority (Art. 77) — the
   Unabhaengiges Datenschutzzentrum Saarland (registered seat is in Saarland),
   plus the user's local authority.
6. International-transfer safeguards: adequacy decision / EU Standard
   Contractual Clauses for transfers outside the EEA.

## File changes

- NEW `src/app/imprint/page.tsx` — Impressum, mirrors the privacy/terms page
  chrome exactly (back link, header, Section, footer cross-links). Cites
  "Information pursuant to Sec. 5 DDG (formerly Sec. 5 TMG)". Reproduces the
  supplied details only; no invented fields (no phone, no journalistic-content
  responsible person, since none were provided).
- `src/components/SiteFooter.tsx` — add Imprint link to the Legal column.
- `src/components/SiteFooter.test.tsx` — add `/imprint` to the required-links
  assertion so reachability is enforced.
- `src/app/privacy/page.tsx` — LEGAL_ENTITY -> Traffic.Club IT GmbH;
  EFFECTIVE_DATE -> 2026-07-01; controller block + imprint link; new legal-bases
  and automated-decisions section (renumbered following sections; no numeric
  cross-references exist, verified); expanded rights + supervisory authority;
  transfer safeguards; footer imprint link.
- `src/app/terms/page.tsx` — LEGAL_ENTITY -> Traffic.Club IT GmbH;
  GOVERNING_LAW -> Germany; EFFECTIVE_DATE -> 2026-07-01; EU consumer-law
  caveat in the governing-law section; footer imprint link.

## Security / safety notes

- No secrets, no PII handling changes, no new dependencies, no network calls.
- Legal-content accuracy is the risk surface: the policy must describe only
  real data flows (hence excluding ad disclosures) and name the correct
  supervisory authority (verified: Unabhaengiges Datenschutzzentrum Saarland).

## Open questions / follow-ups (flagged to user, not blocking this change)

- Footer copyright line still reads "(c) YEAR LoreWire"; could name the legal
  entity. Left as-is (brand vs legal entity is a branding call).
- Terms limitation-of-liability caps ("$100 / fees paid") are drafted
  US-style; under German law those caps may not be fully enforceable. Out of
  scope here; recommend a lawyer review before relying on them.
- This is not legal advice. A German-qualified lawyer should review the
  Impressum and the GDPR wording before it goes live.
