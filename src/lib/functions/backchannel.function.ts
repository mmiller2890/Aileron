/**
 * Detects pure backchannel utterances — acknowledgments ("Yeah.", "Mm-hmm.",
 * "Okay. Awesome.") that carry no content worth keeping in the transcript.
 *
 * Deliberately conservative: an utterance is a backchannel only when EVERY
 * comma/period-separated piece is independently a backchannel token. Anything
 * with a content-bearing piece ("Yeah, that's right") or a question mark
 * ("Why?") falls through. In an interview these are the interviewer's
 * listening noises; committing them as transcript rows floods the record.
 * VAD timing can't separate a 400ms "Yeah" from a 400ms "Why?" — only content
 * can.
 *
 * Matching a SEQUENCE of tokens rather than a single one is what catches the
 * real flooding pattern. A live screening call produced "I see, I see, I
 * see.", "I see, okay.", "Okay. Awesome." and "Oh no." — all pure backchannel,
 * none of which a single-token match drops.
 *
 * Scoped to system audio, i.e. the far end of the call. If mic capture ever
 * joins this pipeline, revisit "no"/"nope": a bare "No." from the near side is
 * a legitimate complete answer to a yes/no question, not a listening noise.
 */

// One backchannel token, with an optional "oh" intensifier ("Oh no.").
const BACKCHANNEL_TOKEN =
  /^(?:oh\s+)?(?:yeah|yes|yep|yup|mm+[-\s]?hm+|mmm+|hmm+|okay|ok|sure|right|uh[-\s]?huh|oh|wow|ha|no|nope|cool|awesome|got it|i see|makes sense)$/i;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;

// Longest plausible run of pure backchannel. Past this it is almost certainly
// content, and not worth splitting.
const MAX_BACKCHANNEL_LENGTH = 80;

export function isBackchannel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (!WORD_CHARACTER_PATTERN.test(trimmed)) {
    return true;
  }

  if (trimmed.length > MAX_BACKCHANNEL_LENGTH) {
    return false;
  }

  // A question-marked utterance is never a backchannel.
  if (trimmed.includes("?")) {
    return false;
  }

  const pieces = trimmed
    .split(/[.,!;]+/)
    .map((piece) => piece.trim())
    .filter(Boolean);

  return pieces.every((piece) => BACKCHANNEL_TOKEN.test(piece));
}
