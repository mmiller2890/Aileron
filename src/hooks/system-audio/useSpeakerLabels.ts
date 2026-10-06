import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ChatConversation, ChatMessage } from "@/types/completion";

export interface SpeakerSegment {
  speaker_id: string;
  start_time: number;
  end_time: number;
  quality_score: number;
}

export interface UtteranceWindow {
  start: number;
  end: number;
}

export interface UtteranceRecord {
  messageId: string | null;
  start: number;
  end: number;
}

export function getSpeakerForUtterance(
  startTime: number,
  endTime: number,
  segments: SpeakerSegment[],
): string | null {
  let bestSpeaker: string | null = null;
  let bestOverlap = 0;
  for (const segment of segments) {
    if (
      !segment.speaker_id ||
      !Number.isFinite(segment.quality_score) ||
      segment.quality_score <= 0 ||
      !Number.isFinite(segment.start_time) ||
      !Number.isFinite(segment.end_time) ||
      segment.end_time <= segment.start_time
    ) {
      continue;
    }
    const overlap =
      Math.min(endTime, segment.end_time) -
      Math.max(startTime, segment.start_time);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = segment.speaker_id;
    }
  }
  return bestSpeaker;
}

/**
 * Speaker-diarization presentation state for a capture session: the segments
 * returned by diarization, which speaker is currently talking, and how
 * segments map onto transcript messages after a session ends.
 */
export function applySpeakerLabels(
  messages: ChatMessage[],
  segments: SpeakerSegment[],
  utterances: UtteranceRecord[],
): ChatMessage[] {
  if (utterances.length === 0 || segments.length === 0) {
    return messages;
  }
  const updated = [...messages];
  let changed = false;
  for (const utterance of utterances) {
    if (!utterance.messageId) {
      continue;
    }
    const index = updated.findIndex(
      (message) =>
        message.id === utterance.messageId &&
        message.role === "user" &&
        !message.speaker,
    );
    if (index === -1) {
      continue;
    }
    const speaker = resolveSpeakerFromSegments(
      utterance.start,
      utterance.end,
      segments,
    );
    if (speaker) {
      updated[index] = {
        ...updated[index],
        speaker,
      };
      changed = true;
    }
  }
  return changed ? updated : messages;
}

function resolveSpeakerFromSegments(
  startTime: number,
  endTime: number,
  segments: SpeakerSegment[],
): string | null {
  let bestSpeaker: string | null = null;
  let bestOverlap = 0;
  for (const segment of segments) {
    if (
      !segment.speaker_id ||
      !Number.isFinite(segment.quality_score) ||
      segment.quality_score <= 0 ||
      !Number.isFinite(segment.start_time) ||
      !Number.isFinite(segment.end_time) ||
      segment.end_time <= segment.start_time
    ) {
      continue;
    }
    const overlap =
      Math.min(endTime, segment.end_time) -
      Math.max(startTime, segment.start_time);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = segment.speaker_id;
    }
  }
  return bestSpeaker;
}

export function useSpeakerLabels(
  setConversation: Dispatch<SetStateAction<ChatConversation>>,
) {
  const [speakerSegments, setSpeakerSegments] = useState<SpeakerSegment[]>([]);
  const [isLabelingSpeakers, setIsLabelingSpeakers] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null);

  const resolveSpeaker = useCallback(getSpeakerForUtterance, []);

  const labelMessagesWithSpeakers = useCallback(
    (segments: SpeakerSegment[], utterances: UtteranceRecord[]) => {
      setConversation((prev) => ({
        ...prev,
        messages: applySpeakerLabels(prev.messages, segments, utterances),
      }));
    },
    [setConversation],
  );

  return {
    speakerSegments,
    setSpeakerSegments,
    isLabelingSpeakers,
    setIsLabelingSpeakers,
    currentSpeaker,
    setCurrentSpeaker,
    getSpeakerForUtterance: resolveSpeaker,
    labelMessagesWithSpeakers,
  };
}
