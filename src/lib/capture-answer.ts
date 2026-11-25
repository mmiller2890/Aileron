/**
 * Rules every answer to captured speech gets, whatever prompt is selected.
 *
 * A capture answer is read aloud by the user to the person they are talking
 * to. On 2026-11-24 an interview ran with the generic default prompt (the
 * user's interview prompt was not selected in that build), and the model
 * answered "No need — I'm an AI" to the interviewer and wrote "[X] years" as
 * a placeholder. These rules hold even when no tailored prompt is active.
 */
export const CAPTURE_ANSWER_RULES =
  "You are writing what the user will say aloud, in their own voice, to the person they are talking with. " +
  "Write in the first person as the user. Never say or imply that you are an AI, an assistant or a language model. " +
  "Never write bracketed placeholders such as [X] or [company]: if a fact about the user is not known, answer without it. " +
  "If what was said is small talk or not a question, reply with a brief natural line the user could say.";

/** The system prompt for an answer to captured speech. */
export function captureAnswerPrompt(selectedPrompt: string): string {
  const base = selectedPrompt.trim();
  return base ? `${base}\n\n${CAPTURE_ANSWER_RULES}` : CAPTURE_ANSWER_RULES;
}

/**
 * Whether a level reading means system audio is arriving. A silent tap
 * reports exactly 0; anything audible is far above this.
 */
export const AUDIBLE_LEVEL = 0.002;
export function isAudible(level: number): boolean {
  return Number.isFinite(level) && level > AUDIBLE_LEVEL;
}
