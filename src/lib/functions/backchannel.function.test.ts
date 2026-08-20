import { describe, expect, it } from "vitest";
import { isBackchannel } from "./backchannel.function";

describe("isBackchannel", () => {
  it("detects common backchannels with optional punctuation", () => {
    expect(isBackchannel("Yeah")).toBe(true);
    expect(isBackchannel("Yeah.")).toBe(true);
    expect(isBackchannel("yes")).toBe(true);
    expect(isBackchannel("yep")).toBe(true);
    expect(isBackchannel("Mm-hmm.")).toBe(true);
    expect(isBackchannel("mmhmm")).toBe(true);
    expect(isBackchannel("Okay")).toBe(true);
    expect(isBackchannel("okay.")).toBe(true);
    expect(isBackchannel("OK")).toBe(true);
    expect(isBackchannel("Sure.")).toBe(true);
    expect(isBackchannel("Right.")).toBe(true);
    expect(isBackchannel("Uh-huh.")).toBe(true);
    expect(isBackchannel("Oh.")).toBe(true);
    expect(isBackchannel("Ha.")).toBe(true);
    expect(isBackchannel("Got it.")).toBe(true);
    expect(isBackchannel("I see.")).toBe(true);
    expect(isBackchannel("Makes sense.")).toBe(true);
  });

  it("never flags question-shaped utterances", () => {
    expect(isBackchannel("Why?")).toBe(false);
    expect(isBackchannel("When?")).toBe(false);
    expect(isBackchannel("Can you tell me about yourself?")).toBe(false);
    expect(isBackchannel("How did you get into IT?")).toBe(false);
    expect(isBackchannel("Okay, so what's next?")).toBe(false);
  });

  it("never flags content-bearing utterances", () => {
    expect(isBackchannel("Yeah, that's right")).toBe(false);
    expect(isBackchannel("No, not at all")).toBe(false);
    expect(isBackchannel("Sure, go ahead")).toBe(false);
    expect(isBackchannel("Oh that's good")).toBe(false);
    expect(isBackchannel("Right, so moving on")).toBe(false);
  });

  it("treats empty and whitespace as not a backchannel", () => {
    expect(isBackchannel("")).toBe(false);
    expect(isBackchannel("   ")).toBe(false);
  });

  it("drops punctuation-only ASR output", () => {
    expect(isBackchannel("...")).toBe(true);
    expect(isBackchannel("!!!")).toBe(true);
    expect(isBackchannel("…")).toBe(true);
    expect(isBackchannel("—")).toBe(true);
    expect(isBackchannel(".".repeat(81))).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isBackchannel("YEAH.")).toBe(true);
    expect(isBackchannel("Mm-Hmm.")).toBe(true);
  });

  // Every string below was captured from a live screening call. A
  // single-token match let all of them through and they flooded the
  // transcript, which is what the sequence match exists to stop.
  describe("compound backchannels from real capture", () => {
    it("drops repeated tokens", () => {
      expect(isBackchannel("I see, I see, I see.")).toBe(true);
      expect(isBackchannel("Yeah, yeah.")).toBe(true);
    });

    it("drops comma- and period-joined token runs", () => {
      expect(isBackchannel("I see, okay.")).toBe(true);
      expect(isBackchannel("Okay. Awesome.")).toBe(true);
      expect(isBackchannel("Yeah, okay, sure.")).toBe(true);
    });

    it("drops an 'oh'-prefixed reaction", () => {
      expect(isBackchannel("Oh no.")).toBe(true);
      expect(isBackchannel("Oh wow.")).toBe(true);
    });

    it("keeps compounds where any piece carries content", () => {
      expect(isBackchannel("Yeah, I saw that.")).toBe(false);
      expect(isBackchannel("Oh that's good. Okay.")).toBe(false);
      expect(isBackchannel("But that's awesome.")).toBe(false);
      expect(isBackchannel("Okay. Tell me about your day to day.")).toBe(false);
    });

    it("keeps a long run that is not entirely backchannel", () => {
      expect(
        isBackchannel("Big difference, I bet too, a bit of a different city.")
      ).toBe(false);
    });
  });

  // Documents a deliberate trade-off rather than an accident. This function
  // only ever sees system audio (the far end of the call), where a bare "No."
  // is a reaction. Revisit if mic capture joins the same pipeline.
  it("treats a bare no as backchannel while scoped to system audio", () => {
    expect(isBackchannel("No.")).toBe(true);
    expect(isBackchannel("Nope.")).toBe(true);
    expect(isBackchannel("No, not at all")).toBe(false);
  });

  it("never drops a question-marked utterance", () => {
    expect(isBackchannel("?")).toBe(false);
    expect(isBackchannel("Okay?")).toBe(false);
    expect(isBackchannel("Yeah?")).toBe(false);
    expect(isBackchannel("Right?")).toBe(false);
    expect(isBackchannel("I see, okay?")).toBe(false);
  });
});
