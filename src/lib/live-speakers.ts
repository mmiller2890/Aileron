/**
 * Turn → speaker bookkeeping for one capture. The final label for a turn and
 * the transcript message for that turn arrive independently; whichever comes
 * second completes the pair.
 */
export interface SpeakerEvent {
  turn: number;
  speaker: string | null;
  final: boolean;
}

export interface LiveSpeakerState {
  /** Who is speaking in the turn in progress, for the provisional line. */
  provisional: { turn: number; speaker: string } | null;
  /** Final label per turn; null means the turn had no clear speaker. */
  finals: Record<number, string | null>;
  /** Transcript message created for each turn. */
  messages: Record<number, string>;
}

export const emptyLiveSpeakerState: LiveSpeakerState = {
  provisional: null,
  finals: {},
  messages: {},
};

export function applySpeakerEvent(
  state: LiveSpeakerState,
  event: SpeakerEvent,
): {
  state: LiveSpeakerState;
  label: { messageId: string; speaker: string } | null;
} {
  if (!event.final) {
    if (!event.speaker) return { state, label: null };
    if (state.provisional && event.turn < state.provisional.turn) {
      return { state, label: null };
    }
    return {
      state: {
        ...state,
        provisional: { turn: event.turn, speaker: event.speaker },
      },
      label: null,
    };
  }

  const next: LiveSpeakerState = {
    ...state,
    finals: { ...state.finals, [event.turn]: event.speaker },
    provisional:
      state.provisional && state.provisional.turn <= event.turn
        ? null
        : state.provisional,
  };
  const messageId = state.messages[event.turn];
  return {
    state: next,
    label:
      messageId && event.speaker
        ? { messageId, speaker: event.speaker }
        : null,
  };
}

export function registerTurnMessage(
  state: LiveSpeakerState,
  turn: number,
  messageId: string,
): { state: LiveSpeakerState; speaker: string | null } {
  return {
    state: { ...state, messages: { ...state.messages, [turn]: messageId } },
    speaker: state.finals[turn] ?? null,
  };
}

export function clearProvisionalThroughTurn(
  state: LiveSpeakerState,
  turn: number | null | undefined,
): LiveSpeakerState {
  if (!state.provisional) return state;
  if (turn === null || turn === undefined || state.provisional.turn <= turn) {
    return { ...state, provisional: null };
  }
  return state;
}
