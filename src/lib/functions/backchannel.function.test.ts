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

  it("matches case-insensitively", () => {
    expect(isBackchannel("YEAH.")).toBe(true);
    expect(isBackchannel("Mm-Hmm.")).toBe(true);
  });
});
