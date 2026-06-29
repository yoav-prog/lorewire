# Processors, DPAs, and international transfers

Tracks the GDPR Article 28 position (a signed Data Processing Agreement with
every processor) and the Chapter V position (a valid mechanism for any transfer
of personal data outside the EU/UK) for each vendor.

**Important:** the "Location" and "Transfer mechanism" columns below are
starting points, not verified legal conclusions. Each `TODO` must be confirmed
against the vendor's current DPA and the controller's own transfer assessment
before this table is authoritative. For EU/UK to US transfers, the usual
mechanisms are the vendor's certification under the **EU-US Data Privacy
Framework (DPF)** (and the UK extension) or **Standard Contractual Clauses
(SCCs)** plus a transfer risk assessment — confirm which applies per vendor.

## Processors that handle public-user personal data

| Processor | Data it receives | Likely location | DPA signed? | Transfer mechanism | Status |
|---|---|---|---|---|---|
| **Neon** (Postgres) | Account data, reader activity, poll votes | US default; EU region available | `TODO(operator)` | `TODO(legal)` DPF/SCC; consider EU region | Open |
| **Vercel** | Hosting, edge IP, request logs | US (global edge) | `TODO(operator)` | `TODO(legal)` | Open |
| **Brevo** (Sendinblue) | Email address for magic-link delivery | EU (France) | `TODO(operator)` | Likely intra-EU; confirm | Open |
| **Google** (OAuth sign-in) | OAuth identifier, email | US / global | `TODO(operator)` | `TODO(legal)` DPF | Open |
| **Microsoft** (OAuth sign-in) | OAuth identifier, email | US / global | `TODO(operator)` | `TODO(legal)` DPF | Open |
| **Reddit** (OAuth sign-in) | OAuth identifier | US | `TODO(operator)` | `TODO(legal)` SCC | Open |
| **Meta / Facebook** (OAuth sign-in, once shipped) | OAuth identifier, email (if shared) | US / global | `TODO(operator)` | `TODO(legal)` | Open |

## Processors in the content pipeline (operator content, not public-user PII)

Listed for completeness. These receive article/script/prompt content, not the
personal data of LoreWire's public users — unless user-generated content is
ever fed in, at which point they move into the table above.

| Processor | Data it receives | Likely location | DPA signed? | Notes |
|---|---|---|---|---|
| **OpenAI** | Prompts / text for inference | US | `TODO(operator)` | Confirm no-training / zero-retention terms |
| **Anthropic** | Prompts / text for inference | US | `TODO(operator)` | Confirm commercial terms |
| **Kie.ai** | Image prompts | `TODO(operator)` confirm | `TODO(operator)` | Least-known vendor; diligence needed |
| **ElevenLabs** | Text for voice synthesis | US | `TODO(operator)` | |
| **Google Cloud (TTS / Storage)** | Text for synthesis; rendered media | US / global | `TODO(operator)` | Same Google DPA may cover |
| **Decodo** | Reddit URLs / search queries | `TODO(operator)` confirm | `TODO(operator)` | Processes public Reddit data, not user PII |

## Actions

- `TODO(operator)`: obtain and counter-sign each processor's DPA (Art. 28(3)).
  Most vendors publish a standard DPA you accept online or by request.
- `TODO(legal)`: for each US-located processor handling public-user data,
  record the transfer mechanism (DPF certification or SCCs + transfer risk
  assessment).
- `TODO(operator)`: consider provisioning Neon in an EU region to remove the
  database transfer entirely (the largest single store of user data).
- `TODO(operator)`: keep this table in sync with the ROPA and with
  `/privacy` §5 (Sharing with third parties).
