/**
 * Provisional text for the turn in progress. It is display-only: the batch
 * transcription of the finished turn replaces it and is what gets saved.
 */
export interface LiveTextPartial {
  turn: number;
  text: string;
}

export type LiveTextState = LiveTextPartial | null;

export function applyPartial(
  state: LiveTextState,
  partial: LiveTextPartial,
): LiveTextState {
  if (!partial.text.trim()) return state;
  if (state && partial.turn < state.turn) return state;
  return { turn: partial.turn, text: partial.text };
}

/**
 * Drop provisional text once the turn it belongs to is settled. With no turn
 * (discard, stop) everything goes. A newer turn's text survives an older
 * turn's final, which can land after the speaker has started again.
 */
export function clearThroughTurn(
  state: LiveTextState,
  turn: number | null | undefined,
): LiveTextState {
  if (!state) return null;
  if (turn === null || turn === undefined) return null;
  return state.turn <= turn ? null : state;
}
