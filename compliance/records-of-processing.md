# Records of Processing Activities (GDPR Article 30)

Controller: Flexelent, operator of LoreWire (`TODO(operator)`: confirm legal
entity + address). Last updated: 2026-06-22. Derived from the verified codebase
state; update when a processing activity or processor changes.

Lawful bases referenced (GDPR Art. 6(1)): **(b) contract**, **(a) consent**,
**(f) legitimate interests**.

---

## 1. Account and authentication

- **Purpose:** create and maintain a user account; authenticate sign-in.
- **Data subjects:** registered public users.
- **Personal data:** email address; password hash (email/password users only);
  OAuth provider identifier and the email it returns (Google, Microsoft, Reddit,
  and Facebook once that ships); display name and picture (if set or supplied by
  the provider); an anonymous device identifier (`lw_anon`) linked at first
  sign-in.
- **Lawful basis:** (b) contract — necessary to provide the account the user
  asked for.
- **Recipients (processors):** Neon (database), the chosen sign-in provider,
  Brevo (sends the one-time magic-link email), Vercel (hosting).
- **Storage / transfer:** Neon (Postgres); see `processors-and-transfers.md` for
  region and Chapter V status.
- **Retention:** while the account is active; erased within 30 days of an
  account-closure request. Magic-link tokens expire in 15 minutes.
- **Security:** passwords scrypt-hashed; sessions are httpOnly signed-JWT
  cookies; OAuth uses state/PKCE; magic-link tokens stored only as SHA-256
  hashes.

## 2. Reader activity (personalization the user opts into)

- **Purpose:** remember the user's saved stories, likes, favorite categories,
  recently viewed items, and reading/watching position so the experience
  persists across visits.
- **Data subjects:** registered public users; anonymous users on a single
  device (before sign-in) where they accepted the cookie banner.
- **Personal data:** story ids saved/liked/viewed; category preferences;
  reading/watching progress; associated to the user id or the `lw_anon` device
  id.
- **Lawful basis:** (a) consent — the cookie banner's Accept stores this
  activity; Reject clears it. For signed-in users it is also (b) contract
  (the feature they signed up to use).
- **Recipients:** Neon; Vercel.
- **Retention:** while active; recently-viewed capped at 50 per user;
  cleared on account deletion. `TODO(operator)`: the 50-row cap and the device
  data clear-on-Reject are enforced in code; confirm the recently-viewed prune
  cron ships (Phase 3).
- **Security:** as above; no third-party analytics or tracking is ever loaded.

## 3. Engagement polls

- **Purpose:** let users vote in two-option polls; show aggregate results;
  prevent duplicate/abusive voting.
- **Data subjects:** any visitor who votes (signed-in or anonymous).
- **Personal data:** the vote (poll, side, timestamp); a random anti-double-vote
  cookie nonce (`lw_vote`); a one-way hash of IP + user-agent for rate-limiting;
  the user id for signed-in votes.
- **Lawful basis:** (f) legitimate interests — measuring aggregate engagement
  and preventing vote manipulation. The IP+UA hash is the minimum needed for
  abuse prevention and is not reversible to an IP.
- **Recipients:** Neon; Vercel (edge IP).
- **Retention:** votes are retained as anonymous aggregate data; the IP+UA hash
  is intended to be nulled after 24 hours (`TODO(operator)`: the prune cron is a
  Phase 3 deliverable — until it ships, this retention promise is not enforced).
  On account deletion the user id, cookie nonce, and IP+UA hash on that user's
  votes are all nulled, leaving an anonymous tally.
- **Balancing test (Art. 6(1)(f)):** `TODO(legal)` record the legitimate-
  interests assessment; impact is low (no profiling, hashed identifiers,
  short retention) and supports a service the user engaged with.

## 4. Transactional email

- **Purpose:** deliver one-time magic-link sign-in emails.
- **Data subjects:** users requesting a magic-link sign-in.
- **Personal data:** email address; the link URL.
- **Lawful basis:** (b) contract — delivering the sign-in the user requested.
- **Recipients:** Brevo (Sendinblue).
- **Retention:** Brevo's sending logs per their policy; the token row expires in
  15 minutes on our side.

## 5. Hosting, security and operational logging

- **Purpose:** serve the application; diagnose failures; prevent abuse.
- **Data subjects:** all visitors.
- **Personal data:** IP address at the edge; request logs (no credentials,
  tokens, or password hashes; user ids appear only as one-way hashes).
- **Lawful basis:** (f) legitimate interests — operating and securing the
  service.
- **Recipients:** Vercel.
- **Retention:** standard hosting log windows (≈30 days).

## 6. Content generation pipeline (not public-user data)

- **Purpose:** generate articles, scripts, captions, images, and voiceovers.
- **Data:** operator-supplied / Reddit-sourced content and prompts — **not the
  personal data of LoreWire's public users.** Recorded here for completeness.
- **Recipients:** OpenAI, Anthropic, Kie.ai, ElevenLabs, Google (TTS/Storage),
  Decodo (Reddit scraping proxy).
- **Note:** if user-generated content ever enters this pipeline, revisit the
  lawful basis and the processor list.

---

`TODO(operator)`: review annually and whenever a new data store, processor, or
processing purpose is added (the build-time registry tests will flag a new
per-user table, but not a new purpose or recipient).
