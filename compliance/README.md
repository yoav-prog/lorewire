# LoreWire GDPR compliance pack

These are the operator-facing compliance documents for LoreWire. They are
drafted from the verified state of the codebase as of 2026-06-22 (see
`_plans/2026-06-22-gdpr-compliance.md` for how they were produced and
council-reviewed). They are **drafts for review, not legal advice** — every
item marked `TODO(legal)` or `TODO(operator)` needs a human decision before
this pack is authoritative.

## What's here

| File | Purpose |
|---|---|
| `records-of-processing.md` | Records of Processing Activities (GDPR Art. 30) — what data is processed, why, on what lawful basis, who receives it, how long it's kept. |
| `processors-and-transfers.md` | Art. 28 processor / DPA tracker and Chapter V international-transfer status for each vendor. |
| `dpia-screening.md` | Art. 35 screening: whether a full Data Protection Impact Assessment is required, with the reasoning. |
| `lawyer-checklist.md` | The legal and organizational items code cannot close. Take this to counsel. |

## Controller of record

- **Controller:** Flexelent, operator of LoreWire. `TODO(operator)`: confirm
  the exact legal entity name, registration number, and registered address.
  This is currently a placeholder in `/privacy` and `/terms` too.
- **Contact / DSAR inbox:** info@lorewire.com (a monitored inbox; DSAR requests
  must be actioned within 30 days, GDPR Art. 12(3)).
- **EU representative (Art. 27):** `TODO(legal)`. Required if the controller has
  no establishment in the EU but offers services to EU data subjects. LoreWire
  serves EU/UK users, so if Flexelent is established outside the EU/UK an Art. 27
  representative (and a UK representative) likely must be appointed.
- **Data Protection Officer:** likely **not required** (Art. 37) — no
  large-scale systematic monitoring and no large-scale special-category
  processing. Confirm in `dpia-screening.md`.

## Scope

These records cover **public users** (readers and account holders, the people
who sign in to save stories, vote in polls, and read articles). The operator's
own staff/admin accounts and the content-generation pipeline are noted where
relevant but are a separate data-subject category.

## How the code backs this up

- The exhaustive map of where public-user data lives is enforced in code:
  `src/lib/account-deletion.ts` (`USER_DATA_TABLES`) for erasure and
  `src/lib/personal-data.ts` (`EXPORT_SOURCES`) for export, each guarded by a
  test that fails the build if a new per-user table is added without being
  registered. When a new data store is added, update the ROPA here too.
