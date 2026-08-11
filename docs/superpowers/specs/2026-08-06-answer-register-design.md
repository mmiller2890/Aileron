# Answer Register — Design

**Date:** 2026-08-06
**Status:** Reverted — historical reference only; do not implement
**Branch:** dev
**Goal:** Make live drafted answers read as spoken speech from a person with real opinions, rather than written credential summaries. Triggered by a real screening call where the interviewer responded to a drafted answer with "You can be honest, it's okay."

The implementation and prompt rewrite in `94a4985`, `e760cd9`, `dfff0a9`,
and `ea4e4b4` were reverted by `e367f72`, `a7ecc60`, `18da62f`, and
`d9e710f`. The changes singled out one issue, expanded beyond the intended
scope, and produced worse transcriptions in testing.

## Background

A live 30-minute screening call produced answers that were structurally correct and tonally wrong: full polished paragraphs, no hesitation, and the company's mission language quoted back to the interviewer. The interviewer invited honesty three times and received polish three times.

The user's system prompt already asks for the right thing — "conversational—not like a résumé, textbook, or generated script", "Natural spoken English", "Prefer short spoken paragraphs". It was asking correctly and being overridden.

## Verified facts (driving the scope)

- **The live-answer path composes four instruction blocks, user prompt first.** `fetchAIResponse` calls `buildEnhancedSystemPrompt(systemPrompt)` unconditionally (`src/lib/functions/ai-response.function.ts:79`). That function pushes, in order: base prompt, response-length directive, language directive, `MARKDOWN_FORMATTING_INSTRUCTIONS` (`ai-response.function.ts:25-48`).
- **The live path goes through `fetchAIResponse`** — `src/hooks/useSystemAudio.ts:594`.
- **The appended length directive is written-register and emphasis-flagged.** Default is `auto` (`src/lib/response-settings.constants.ts:218`), whose text reads "IMPORTANT: … For moderate questions, provide balanced detail (1-2 paragraphs) … no more, no less." (`response-settings.constants.ts:36-37`). The observed "tell me about yourself" answer was one paragraph of five sentences — exactly what this asks for.
- **Markdown instructions reach spoken answers.** `MARKDOWN_FORMATTING_INSTRUCTIONS` (`src/config/constants.ts:33`) instructs use of `$$` math, triple-backtick code blocks, ```mermaid diagrams, and markdown tables — appended to answers the user speaks aloud.
- **Blocks join with a single space** (`ai-response.function.ts:48`). Every block ends in a period, so this produces run-on paragraphs, **not** mid-sentence corruption. An earlier claim of mid-sentence corruption was wrong and is corrected here.
- **No interview prompt ships in the app.** `DEFAULT_SYSTEM_PROMPT` is "You are a helpful AI assistant. Be concise, accurate, and friendly in your responses" (`src/config/constants.ts:29-30`). No seeded rows in `system_prompts`. The interview prompt is entirely user-authored.
- **`buildEnhancedSystemPrompt` has exactly one caller** — `ai-response.function.ts:79`. Nothing else composes prompts.

## Diagnosis

Three causes, ranked by contribution:

1. **App-level blocks override the user's prompt.** They are appended *after* it, two are flagged IMPORTANT, and they measure output in paragraphs and sentences. Later and louder wins. This is a code defect.
2. **The prompt demonstrates what it forbids.** Roughly 60% of it is a résumé inventory. It tells the model "don't sound like a résumé" while showing it one. Demonstration beats description.
3. **Nothing licenses ambivalence.** Every rule pushes toward relentless positivity, so three invitations to be honest produced three deflections.

## Code changes

Touches `src/lib/functions/ai-response.function.ts`, its test, and the spoken call sites in `src/hooks/useSystemAudio.ts`. No file-load path is added.

1. **`fetchAIResponse` gains `channel?: "chat" | "spoken"`, defaulting to `"chat"`.** Existing callers unchanged.
2. **`buildEnhancedSystemPrompt(baseSystemPrompt, channel)`** — when `spoken`, omit the response-length directive and `MARKDOWN_FORMATTING_INSTRUCTIONS`. Language is kept; it still applies.
3. **Join blocks with `\n\n` on both channels.** Deliberately *not* gated behind the channel flag. Block separation aids instruction-following in chat too; hiding the fix behind a backward-compatible default would preserve a defect on purpose. Chat expectations are updated as an intended behavior change.
4. **Spoken call sites** pass `channel: "spoken"`: the auto-answer path, the answer-last-utterance shortcut, and quick actions. The session summary stays `"chat"` — it is read, not spoken. Exact call sites enumerated during implementation.

### Tests

- spoken output excludes the length directive and markdown instructions
- chat output includes both
- language directive present on both
- blocks separated by `\n\n` on both

## Prompt changes

The prompt is **single-channel** — it drives spoken answers only. Markdown/table instructions never lived in it; they came from the app constant. There are therefore no channel-conditional sections and no internal contradiction. The contradiction was between the prompt and the appended blocks, which the code change removes.

**Kept:** first-person voice, lead-with-the-answer, STAR-without-announcing, the technical/security/automation depth rules, pronoun-free "Morgan" phrasing.

**Changed:**

- **Background becomes reference, not exemplar.** Explicitly labeled as facts to draw on, never to recite. Taxonomy lists cut to load-bearing specifics.
- **No unprompted enumeration.** Don't volunteer technologies the question didn't ask about. When a question *does* ask for the stack or the approach, name everything genuinely load-bearing. The constraint targets volunteering credentials, not technical specificity, so it never binds on technical questions.
- **Depth over coverage.** One example explored, not four surveyed evenly.
- **Honesty license, scoped and specific.** Applies only to questions that explicitly ask what is missing, frustrating, limiting, or hard. On those, name the real constraint before any silver lining, and the constraint must be concrete and checkable — "security is a separate org, so I don't get to touch it" rather than "not enough growth opportunity". Specificity is what separates credible candor from manufactured complaint. Permission to say Morgan hasn't done something, paired with how Morgan would approach it.
- **Own words, not their sentence.** May reference why the work matters and cite something specific and checkable — a program, a number, a constraint the organization operates under. Never quote or paraphrase mission, values, or marketing copy back to the interviewer. This is not a ban on values alignment; it is a ban on reciting their tagline.
- **Spoken texture.** Contractions always. Sharply varied sentence length. Fragments are fine. One hedge or self-correction per answer is a feature.
- **Match depth to the question** — specified as a table, below.

### Question classes

The load-bearing rule. Specified as an explicit taxonomy because worked examples drive behavior where principles do not.

| Class | Example | Target | Depth |
|---|---|---|---|
| Incidental rapport | "Big difference from the city?" | 5–15s | React like a person. Do not pivot to credentials. |
| Headline intro | "Tell me about yourself" | 60–90s | An arc, not an inventory. Two roles, one specific thing you did. |
| Motivation / fit | "Why leaving?" "Why us?" | 30–60s | One real reason, concrete. No values quoted back. |
| Behavioral | "Tell me about a time…" | 60–90s | STAR unannounced. One story. Most of it on your decisions. |
| Technical shallow | "Do you know Intune?" | 15–30s | Answer, one proof point, stop. |
| Technical deep | "How would you troubleshoot…" | 90–120s | Full diagnostic sequence. Name every load-bearing tool. |

**Length is not being cut.** An earlier draft proposed 20–40s for the intro question. That inferred a length problem from an authenticity failure — nobody complained the 56-second answer was long; density made it feel long. The intro stays at 60–90s. Only incidental rapport gets materially shorter.

## Where things live

`docs/prompts/interview-copilot.md`, committed in two steps: the current prompt verbatim first, then the rewrite, so the change is a reviewable diff and nothing authored is lost.

**Mechanism: paste-into-settings.** The app reads its prompt from its own storage. The doc is the canonical copy and changelog; it is **not** loaded at runtime. This gives a versioned, diffable history between calls. It does **not** guarantee the live prompt matches the doc — the user re-pastes after edits, and drift is possible. Closing that gap means seeding the prompt as a built-in preset, deferred below.

## Validation

**Automated:** the composer tests above.

**Prompt quality is not unit-testable.** Side-by-side replay of old vs. new prompt across two sets:

- *In-sample* (from the live transcript): "tell me about yourself", "what's your day to day", "what are you looking for in a new opportunity". These measure whether the known failures are fixed.
- *Held-out* (not seen during the rewrite): a technical depth probe, "tell me about a time you were wrong", "what would you do in your first 90 days". These are the ones that measure generalization; the in-sample set alone would only measure fit to three answers.

**Gates are proxies, not the property.** "No mission language", "≤4 technologies in the intro answer", "names a concrete constraint before any upside" are cheap leaky measures of "sounds spoken". They are useful as tripwires and are not evidence of success on their own. The real verdict is the next live call.

## Deferred

- **Built-in interview preset** (Approach 3). Would eliminate paste-drift and make Aileron good out of the box. Deferred until the prompt has survived a real call, so the shipped preset reflects validated content rather than a guess.
- **Per-stage register switching** (screening / behavioral / technical). Deferred in favor of fixing register and stance globally; the question-class table covers most of the benefit without a switch to hit mid-conversation.
- **Speaker-label reversal** (`src/hooks/system-audio/useSpeakerLabels.ts:57-66`) and the **`no`/`nope` backchannel trade-off** — both blocked on the deferred mic-source toggle, both documented in place.
