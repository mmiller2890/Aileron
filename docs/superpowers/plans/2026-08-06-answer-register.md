# Answer Register Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live drafted answers read as spoken speech rather than written credential summaries, by stopping chat-oriented instruction blocks from overriding the spoken prompt and by rewriting the prompt itself.

**Architecture:** `fetchAIResponse` gains an optional `channel` parameter. On the `"spoken"` channel, `buildEnhancedSystemPrompt` omits the response-length directive and the markdown formatting instructions — both are written-channel instructions appended *after* the caller's prompt, where they outrank it. The block separator becomes a blank line on both channels. The interview prompt itself is archived verbatim, then rewritten.

**Tech Stack:** TypeScript, React, Vitest, Tauri.

## Global Constraints

- Branch: `dev`. All work lands there; `main` is frozen.
- Design source of truth: `docs/superpowers/specs/2026-08-06-answer-register-design.md`.
- The default channel is `"chat"`. Every existing caller keeps current behavior except for the block separator, which changes deliberately on both channels.
- The prompt is single-channel (spoken only). Never add markdown/table/diagram instructions to it.
- The prompt stays pronoun-free — refer to "Morgan", never to he/she/they.
- Prompt file is reference and changelog only. It is **not** loaded at runtime; the live prompt is pasted into app settings by the user.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/functions/ai-response.function.ts` (modify) | Channel-aware system prompt composition |
| `src/lib/functions/ai-response-prompt-composition.test.ts` (create) | Tests for composition by channel |
| `src/hooks/useSystemAudio.ts` (modify, line 594) | Pass `channel: "spoken"` on the live answer path |
| `docs/prompts/interview-copilot.md` (create) | Canonical copy of the interview prompt |

---

### Task 1: Channel-aware system prompt composition

**Files:**
- Modify: `src/lib/functions/ai-response.function.ts:23-49` (composer), `:51-62` (params type), `:64-72` (destructure), `:79` (call)
- Test: `src/lib/functions/ai-response-prompt-composition.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type PromptChannel = "chat" | "spoken";` and a `channel?: PromptChannel` field on the `fetchAIResponse` params object. Task 2 relies on both.

- [ ] **Step 1: Write the failing test**

Create `src/lib/functions/ai-response-prompt-composition.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TYPE_PROVIDER } from "@/types";

const { tauriFetchMock } = vi.hoisted(() => ({
  tauriFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

// Distinctive markers so assertions cannot pass by accident on real copy.
vi.mock("@/lib", () => ({
  getResponseSettings: () => ({
    responseLength: "auto",
    language: "english",
    autoScroll: true,
    thinking: "off",
  }),
  RESPONSE_LENGTHS: [
    { id: "auto", title: "Auto", description: "", prompt: "LENGTH_DIRECTIVE" },
  ],
  LANGUAGES: [
    { id: "english", name: "English", flag: "", prompt: "Respond in English." },
  ],
}));

const { fetchAIResponse } = await import("./ai-response.function");

const BODY = `{"system": "{{SYSTEM_PROMPT}}", "messages": [{"role": "user", "content": "{{TEXT}}"}]}`;

const streamingProvider = (): TYPE_PROVIDER =>
  ({
    id: "custom-stream",
    curl: `curl -X POST http://x.test/v1/chat/completions -H "Content-Type: application/json" -d '${BODY}'`,
    responseContentPath: "choices[0].message.content",
    streaming: true,
  }) as TYPE_PROVIDER;

/** Serve an SSE payload as a real ReadableStream body. */
const sseResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 }
  );
};

/** Drive one request and return the composed system prompt from its body. */
const composedPrompt = async (channel?: "chat" | "spoken"): Promise<string> => {
  tauriFetchMock.mockResolvedValueOnce(
    sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ])
  );
  for await (const _chunk of fetchAIResponse({
    provider: streamingProvider(),
    selectedProvider: { provider: "custom-stream", variables: {} },
    systemPrompt: "BASE_PROMPT",
    userMessage: "hello",
    channel,
  })) {
    // drain the generator so the request completes
  }
  const init = tauriFetchMock.mock.calls[0][1];
  return JSON.parse(init.body).system;
};

beforeEach(() => {
  tauriFetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("system prompt composition by channel", () => {
  it("includes length and markdown directives on the chat channel", async () => {
    const prompt = await composedPrompt("chat");
    expect(prompt).toContain("BASE_PROMPT");
    expect(prompt).toContain("LENGTH_DIRECTIVE");
    expect(prompt).toContain("mermaid");
    expect(prompt).toContain("Respond in English.");
  });

  it("defaults to the chat channel when none is given", async () => {
    const prompt = await composedPrompt();
    expect(prompt).toContain("LENGTH_DIRECTIVE");
    expect(prompt).toContain("mermaid");
  });

  it("drops the length directive on the spoken channel", async () => {
    const prompt = await composedPrompt("spoken");
    expect(prompt).toContain("BASE_PROMPT");
    expect(prompt).not.toContain("LENGTH_DIRECTIVE");
  });

  it("drops markdown formatting instructions on the spoken channel", async () => {
    const prompt = await composedPrompt("spoken");
    expect(prompt).not.toContain("mermaid");
    expect(prompt).not.toContain("```");
  });

  it("keeps the language directive on the spoken channel", async () => {
    const prompt = await composedPrompt("spoken");
    expect(prompt).toContain("Respond in English.");
  });

  it("separates blocks with a blank line on both channels", async () => {
    expect(await composedPrompt("chat")).toContain("\n\n");
    expect(await composedPrompt("spoken")).toContain("\n\n");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/functions/ai-response-prompt-composition.test.ts`

Expected: FAIL. The spoken cases fail because `channel` is not yet a parameter, so every call composes the chat prompt — `LENGTH_DIRECTIVE` and `mermaid` are present when the test expects them absent. The blank-line case also fails (blocks currently join with `" "`).

- [ ] **Step 3: Implement the composer change**

In `src/lib/functions/ai-response.function.ts`, replace `buildEnhancedSystemPrompt` (lines 23-49) with:

```ts
export type PromptChannel = "chat" | "spoken";

function buildEnhancedSystemPrompt(
  baseSystemPrompt?: string,
  channel: PromptChannel = "chat"
): string {
  const responseSettings = getResponseSettings();
  const prompts: string[] = [];

  if (baseSystemPrompt) {
    prompts.push(baseSystemPrompt);
  }

  // Spoken answers get read aloud. The length directive measures output in
  // paragraphs and sentences, and the markdown block asks for tables, code
  // fences and mermaid diagrams. Both are written-channel instructions, and
  // both land AFTER the caller's prompt — where they outrank whatever spoken
  // register it asked for.
  const isSpoken = channel === "spoken";

  if (!isSpoken) {
    const lengthOption = RESPONSE_LENGTHS.find(
      (l) => l.id === responseSettings.responseLength
    );
    if (lengthOption?.prompt?.trim()) {
      prompts.push(lengthOption.prompt);
    }
  }

  const languageOption = LANGUAGES.find(
    (l) => l.id === responseSettings.language
  );
  if (languageOption?.prompt?.trim()) {
    prompts.push(languageOption.prompt);
  }

  if (!isSpoken) {
    prompts.push(MARKDOWN_FORMATTING_INSTRUCTIONS);
  }

  // Blank line between blocks. Every block ends in a period, so a single
  // space ran them into one paragraph and blurred the boundaries.
  return prompts.join("\n\n");
}
```

- [ ] **Step 4: Thread the parameter through `fetchAIResponse`**

In the params type (line 51-62), add after `systemPrompt?: string;`:

```ts
  channel?: PromptChannel;
```

In the destructure (line 64-72), add `channel` to the destructured names:

```ts
      channel = "chat",
```

At line 79, pass it:

```ts
    const enhancedSystemPrompt = buildEnhancedSystemPrompt(systemPrompt, channel);
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `npx vitest run src/lib/functions/ai-response-prompt-composition.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`

Expected: all suites pass, no type errors. If `ai-response-stream.test.ts` fails, read the failure before changing anything — it mocks `RESPONSE_LENGTHS: []` and `LANGUAGES: []`, so it composes only the base prompt plus markdown and should be unaffected by the separator change.

- [ ] **Step 7: Commit**

```bash
git add src/lib/functions/ai-response.function.ts src/lib/functions/ai-response-prompt-composition.test.ts
git commit -m "feat: add spoken channel to system prompt composition

Spoken answers inherited two written-channel instruction blocks appended
after the caller's prompt: the response-length directive measuring output
in paragraphs and sentences, and the markdown block asking for tables,
code fences and mermaid diagrams. Both outranked the spoken register the
prompt asked for.

The spoken channel drops both and keeps language. Block separator moves
from a single space to a blank line on BOTH channels — every block ends
in a period, so the old join ran them into one paragraph."
```

---

### Task 2: Wire the spoken channel on the live answer path

**Files:**
- Modify: `src/hooks/useSystemAudio.ts:594`

**Interfaces:**
- Consumes: `channel?: PromptChannel` on `fetchAIResponse` params, from Task 1.
- Produces: nothing consumed by later tasks.

**Note on verification:** this is a one-line wiring change inside a 1,400-line hook that has no test harness (`useSystemAudio` is the codebase's largest untested hotspot, degree 398). Building a hook harness is out of scope for this plan and was deferred in the design. Verification is typecheck plus targeted inspection, and this is called out rather than papered over with a source-grepping assertion that would pass without proving behavior.

- [ ] **Step 1: Confirm the call sites before editing**

Run: `grep -n "fetchAIResponse({" src/hooks/useSystemAudio.ts`

Expected: exactly two hits — line 594 (the `processWithAI` answer path) and line 774 (the session summary). All four spoken entry points (auto-answer at line 380, quick actions at line 461, answer-last-utterance at line 719, and the shortcut at line 1380) funnel through `processWithAI`, so line 594 is the only site that needs the flag.

- [ ] **Step 2: Add the channel flag**

At `src/hooks/useSystemAudio.ts:594`, inside the `fetchAIResponse({ ... })` argument object, add:

```ts
              channel: "spoken",
```

Place it after `signal,`. Leave line 774 untouched — the session summary is read on screen, not spoken.

- [ ] **Step 3: Verify the summary path was not changed**

Run: `grep -n -A 10 "fetchAIResponse({" src/hooks/useSystemAudio.ts | grep -c "channel"`

Expected: `1`. Exactly one of the two call sites carries a channel.

- [ ] **Step 4: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`

Expected: no type errors, all suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSystemAudio.ts
git commit -m "feat: draft live answers on the spoken channel

All four spoken entry points (auto-answer, quick actions,
answer-last-utterance, shortcut) funnel through processWithAI, so the
single fetchAIResponse call there carries the flag. The session summary
stays on the chat channel — it is read, not spoken."
```

---

### Task 3: Archive the current prompt verbatim

**Files:**
- Create: `docs/prompts/interview-copilot.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the file Task 4 rewrites. Committing it unchanged first is what makes Task 4 a reviewable diff.

- [ ] **Step 1: Create the file with the current prompt, unmodified**

Create `docs/prompts/interview-copilot.md`. Paste the user's existing interview prompt **exactly as it is today**, with no edits, reflow, or corrections — this commit's only job is to establish the baseline. Prepend only this header:

```markdown
# Interview Copilot — System Prompt

**Status:** Canonical copy. NOT loaded at runtime — paste into the app's
system prompt settings after editing. Drift between this file and the live
prompt is possible; this file is the source of truth and changelog.

---
```

The prompt body begins at "You are Morgan Miller's real-time interview copilot." and runs through "…understands both the technology and the business consequences of the decision."

- [ ] **Step 2: Verify nothing but the header was added**

Run: `wc -l docs/prompts/interview-copilot.md`

Expected: roughly 175-185 lines. If it is far shorter, a section was dropped during the paste — re-check against the prompt in the conversation before committing.

- [ ] **Step 3: Commit**

```bash
git add docs/prompts/interview-copilot.md
git commit -m "docs: archive the current interview prompt verbatim

Baseline commit so the register rewrite lands as a reviewable diff and
nothing authored is lost. Not loaded at runtime — the live prompt is
pasted into app settings."
```

---

### Task 4: Rewrite the prompt for spoken register

**Files:**
- Modify: `docs/prompts/interview-copilot.md`

**Interfaces:**
- Consumes: the baseline file from Task 3.
- Produces: the prompt Task 5 validates.

- [ ] **Step 1: Replace the prompt body**

Keep the Task 3 header. Replace everything below the `---` with:

```markdown
You are Morgan Miller's real-time interview copilot. Produce the answer
Morgan can say out loud, right now, in a live interview.

The incoming text is a transcribed interview question. It may contain
transcription errors, dropped words, or filler. Infer the intent and answer
that.

## What you are producing

Speech, not writing. Morgan reads your output aloud while a person waits.
That constrains everything below.

Return only the words Morgan says. No labels, no coaching, no commentary,
nothing about being an AI.

## Register

Write how people talk:

- Contractions, always.
- Vary sentence length hard. Some sentences run long and work through a
  thought. Some are four words. Fragments are fine.
- One hedge or self-correction per answer is good, not a flaw. "Honestly,"
  "I mean," "the short version is," "actually, let me back up."
- Natural openers are fine: "Sure," "Yeah, so," "Right."
- Not every sentence has to land. A paragraph of aphorisms sounds written.

Never sound like a résumé read aloud. The loudest tell is enumeration —
reeling off tools, roles, or achievements nobody asked about.

**Do not volunteer technologies the question didn't ask about.** If the
question asks for the stack or the approach, name everything genuinely
load-bearing. Otherwise one concrete detail beats a list every time.

**Go deep on one thing rather than covering four evenly.** An answer giving
equal time to four jobs is a résumé. An answer that picks one and gets
specific is a person.

## Depth — match the question

| The question | How long | What it needs |
|---|---|---|
| Incidental chat ("big difference from the city?") | 5-15s | React like a person. Do not pivot to credentials. |
| "Tell me about yourself" | 60-90s | An arc, not an inventory. Two roles at most, one specific thing Morgan actually did. |
| "Why are you leaving?" / "Why us?" | 30-60s | One real reason, concrete. |
| "Tell me about a time…" | 60-90s | One story. STAR, never announced. Most of the time on Morgan's decisions. |
| "Do you know X?" | 15-30s | Answer it, one proof point, stop. |
| "How would you troubleshoot X?" | 90-120s | Full diagnostic sequence. Name every load-bearing tool. |

When in doubt, shorter. Morgan can always be asked to expand and cannot take
words back.

## Honesty

When the interviewer asks what is missing, frustrating, limiting, or hard —
or explicitly invites candor — give a real answer with a real edge, and give
it before any silver lining.

The constraint must be concrete and checkable. "Security is a separate org,
so I don't get to touch it" is credible. "Not enough growth opportunity" is a
manufactured complaint and reads worse than polish does.

A candidate with nothing to say here sounds rehearsed or incurious.

Morgan may say he hasn't done something specific — follow it with how Morgan
would approach it. Never dead-end on "I don't know" alone.

## Why this company

Give a specific, slightly self-interested reason: the work itself, the scope,
the problem, something Morgan actually looked up.

Never quote or paraphrase the company's mission, values, or marketing copy
back to the interviewer. Reciting their own sentence at them is the loudest
rehearsed tell there is. Caring about the work is fine — say it in Morgan's
words.

Do not invent facts about their infrastructure, policies, or scale. State an
assumption and say how the approach would adapt.

## Technical answers

- Lead with the direct answer, then the approach in a logical order.
- Consider scope, impact, what changed, reproducibility, logs, dependencies,
  network path, identity state, endpoint state, security controls.
- Isolate variables before touching production. Prefer reversible changes,
  staged rollouts, rollback plans, least privilege.
- Say how success gets validated, technically and from the user's side.
- Close with prevention when it earns the time: monitoring, automation,
  documentation, root cause.

For security: least privilege, identity verification, auditability, secure
defaults, patching, segmentation, change control, containment. Never
recommend bypassing a control for convenience.

For automation: the manual problem first, then design, validation, error
handling, logging, rollback, and the measurable benefit.

For executive and VIP support: discretion, urgency, composure, contingency.
Keep the stakeholder informed without burying them in detail.

## Reference — Morgan's background

**This section is reference material for facts. It is not a style model.
Never recite it, never list its contents, never work through it in order.**

**Meta — Enterprise Support Technician.** Escalation point for high-priority
issues across macOS, Windows, Linux. 500+ endpoint fleet via JAMF and Intune:
deployment, configuration, compliance, endpoint hardening, vulnerability
remediation. Okta identity lifecycle and scripted provisioning/offboarding.
Executive and high-visibility meeting support. SOPs and runbooks.

**Outlier AI — Remote IT Support.** 1,000+ distributed users. Windows, macOS,
Linux, Google Workspace, Slack. Owned the onboarding/offboarding lifecycle,
built automation workflows.

**Novant Health — Tier 2.** 500+ Active Directory users including physicians
and VIPs. Endpoints, mobile, conferencing, Zoom Rooms.

**Synchrony Financial — Desktop and executive support.** JAMF, Intune, Okta,
Slack, Google Workspace, Zoom, DNS, DHCP, VPN, Wi-Fi.

**AIG — Enterprise IT.** Active Directory, Citrix, Intune, networking,
patching, endpoint protection, security monitoring, executive support.

**BECA — Desktop support and infrastructure projects.** Windows and macOS
administration, inventory, licensing, network upgrades, server maintenance,
deployments.

Also: Python, Bash, scripting and workflow automation, APIs. TCP/IP, DNS,
DHCP, VPN, Wi-Fi, SSH, firewalls. Azure, VMware ESXi, Hyper-V. Incident,
change, and asset management. Cybersecurity Bootcamp, UNC Charlotte. BA
History, Winston-Salem State.

6+ years total. The résumé is a summary, not a boundary — answer adjacent and
advanced questions with expert knowledge, not hesitation.
```

- [ ] **Step 2: Check the constraints the rewrite has to satisfy**

Run: `grep -nE "\b(he|him|his|she|her|they|them)\b" docs/prompts/interview-copilot.md`

Expected: one hit only — "Morgan may say he hasn't done something specific" in the Honesty section. Rewrite that line to "Morgan may say a specific thing hasn't come up before" so the file is fully pronoun-free, then re-run and expect zero hits.

Run: `grep -ciE "mermaid|code block|markdown table" docs/prompts/interview-copilot.md`

Expected: `0`. The prompt is single-channel and must never carry written-channel formatting instructions.

- [ ] **Step 3: Commit**

```bash
git add docs/prompts/interview-copilot.md
git commit -m "docs: rewrite interview prompt for spoken register

Background reframed as reference rather than a style exemplar and cut to
load-bearing facts — the old inventory taught answers to sound like a
credential list. Adds: no unprompted enumeration, depth-per-question-class
table, honesty license scoped to questions that ask and requiring a
concrete constraint, and own-words instead of the company's tagline.

Length is unchanged. An earlier draft cut the intro answer to 20-40s,
which inferred a length problem from an authenticity failure — nobody
complained the 56-second answer was long."
```

---

### Task 5: Side-by-side validation replay

**Files:**
- Create: `docs/prompts/2026-08-06-register-replay.md`

**Interfaces:**
- Consumes: the rewritten prompt from Task 4.
- Produces: the record that decides whether the rewrite ships.

- [ ] **Step 1: Generate answers under both prompts**

In the app, run each question below twice — once with the archived prompt from Task 3, once with the rewrite from Task 4 — and record both answers verbatim.

*In-sample* (from the live call; these measure whether known failures are fixed):

1. "Tell me a little bit about what you've been up to most recently, and anything relevant for our conversation — background, experience, skill set."
2. "Are you still at Meta? Tell me about your day to day. What's your day to day like there?"
3. "What is it that you're looking for in a new opportunity, or what's missing from your current role that's making you want to look somewhere else?"

*Held-out* (not seen during the rewrite; these measure generalization, and are the ones that actually matter):

4. "Walk me through how you'd troubleshoot a user who can't authenticate to a SaaS app after a laptop refresh."
5. "Tell me about a time you were wrong about something technical."
6. "What would you do in your first 90 days here?"

- [ ] **Step 2: Score against the gates**

These are **proxies** for "sounds spoken", not the property itself. They are tripwires — passing them is not evidence of success.

| Gate | Applies to | Pass condition |
|---|---|---|
| No mission language | 3, 6 | No phrase lifted from the company's mission or marketing copy |
| Enumeration | 1 | Names at most 4 technologies |
| Real constraint | 3 | Names a concrete, checkable constraint before any upside |
| Contractions | all | Every answer uses them |
| Depth match | 4 vs. 5 | Q4 runs materially longer and names more tools than Q5 |
| No credential pivot | 5, 6 | Neither falls back to reciting the background section |

Q5 is the load-bearing one: it requires admitting fault, which the old prompt had no license to do. Q6 is the enumeration stress test — there is no résumé to recite, so a weak rewrite will invent one.

- [ ] **Step 3: Record the result**

Write `docs/prompts/2026-08-06-register-replay.md` with all twelve answers, the gate table filled in, and a plain verdict: ship, revise, or revert. If any held-out question regresses relative to the archived prompt, note which rule caused it — that is the rule to soften.

- [ ] **Step 4: Commit**

```bash
git add docs/prompts/2026-08-06-register-replay.md
git commit -m "docs: record register replay across in-sample and held-out questions"
```

- [ ] **Step 5: The real test**

The replay is a smoke test. The verdict is the next live call. After it, record what actually happened against the six gates and revise from evidence rather than from this plan's guesses.

---

## Self-Review

**Spec coverage.** §1 diagnosis → Tasks 1-2. §2 code changes, including the deliberate both-channel separator → Task 1. §3 prompt changes, all seven bullets plus the question-class table → Task 4. §4 mechanism and two-commit archive → Tasks 3-4. §5 validation with in-sample *and* held-out sets and proxies named as proxies → Task 5. Deferred items are recorded in the spec and are correctly absent here.

**Placeholder scan.** No TBDs. Every code step carries real code; every verification step carries a real command and an expected result. Task 2's verification is explicitly inspection-plus-typecheck with the reason stated, rather than a fabricated test.

**Type consistency.** `PromptChannel` is defined once in Task 1 and used with the same name and the same two members in Tasks 1 and 2. `channel` is the parameter name throughout. `buildEnhancedSystemPrompt(baseSystemPrompt, channel)` matches its call at line 79.

**One issue found and fixed inline:** the Task 4 prompt body contained "Morgan may say he hasn't done something", violating the pronoun-free global constraint. Rather than silently correcting the draft, Task 4 Step 2 greps for it and fixes it — the implementer runs the check and sees why it matters.
