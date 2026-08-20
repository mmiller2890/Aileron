import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ChatConversation } from "@/types/completion";

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
export function useSpeakerLabels(
  setConversation: Dispatch<SetStateAction<ChatConversation>>
) {
  const [speakerSegments, setSpeakerSegments] = useState<SpeakerSegment[]>([]);
  const [isLabelingSpeakers, setIsLabelingSpeakers] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null);

  const resolveSpeaker = useCallback(getSpeakerForUtterance, []);

  const labelMessagesWithSpeakers = useCallback(
    (segments: SpeakerSegment[], timestamps: UtteranceWindow[]) => {
      setConversation((prev) => {
        if (timestamps.length === 0 || segments.length === 0) {
          return prev;
        }
        const updated = [...prev.messages];
        const userMessageIndices: number[] = [];
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i]?.role === "user" && !updated[i].speaker) {
            userMessageIndices.push(i);
            if (userMessageIndices.length >= timestamps.length) {
              break;
            }
          }
        }
        timestamps.forEach((ts, index) => {
          const userMsgIndex = userMessageIndices[index];
          if (userMsgIndex === undefined) {
            return;
          }
          const speaker = resolveSpeaker(ts.start, ts.end, segments);
          if (speaker) {
            updated[userMsgIndex] = {
              ...updated[userMsgIndex],
              speaker,
            };
          }
        });
        return { ...prev, messages: updated };
      });
    },
    [resolveSpeaker, setConversation]
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
