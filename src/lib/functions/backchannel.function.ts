/**
 * Detects pure backchannel utterances — short acknowledgments ("Yeah.",
 * "Mm-hmm.", "Okay.") that carry no content worth keeping in the transcript.
 *
 * Deliberately conservative: only matches utterances that are ENTIRELY a
 * backchannel word/phrase. Anything longer ("Yeah, that's right") or
 * question-shaped ("Why?") falls through. In an interview, backchannels are
 * the interviewer's listening noises; committing them as transcript rows
 * floods the record. VAD timing can't separate a 400ms "Yeah" from a 400ms
 * "Why?" — only content can.
 */

const BACKCHANNEL_PATTERN =
  /^(?:yeah|yes|yep|yup|mm+[- ]?hm+|mmm+|hmm+|okay|ok|sure|right|uh-huh|oh|wow|ha|no|nope|cool|got it|i see|makes sense)\.?!?\s*$/i;

export function isBackchannel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 20) {
    return false;
  }
  return BACKCHANNEL_PATTERN.test(trimmed);
}
