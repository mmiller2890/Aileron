import { describe, expect, test } from "vitest";
import { buildDynamicMessages, processUserMessageTemplate } from "./common.function";

// OpenAI-style vision template: the image payload is a structured node that
// happens to carry the same placeholder string users can type as literal text.
const visionTemplate = {
  role: "user",
  content: [
    { type: "text", text: "{{TEXT}}" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,{{IMAGE}}" },
    },
  ],
};

describe("processUserMessageTemplate", () => {
  test("preserves literal {{IMAGE}} in the user text when no images are attached", () => {
    const result = processUserMessageTemplate(
      visionTemplate,
      "explain this: {{IMAGE}}"
    );

    expect(result).toEqual({
      role: "user",
      content: [{ type: "text", text: "explain this: {{IMAGE}}" }],
    });
  });

  test("injects the image and preserves literal {{IMAGE}} in the text", () => {
    const result = processUserMessageTemplate(
      visionTemplate,
      "explain {{IMAGE}}",
      ["abc123"]
    );

    expect(result).toEqual({
      role: "user",
      content: [
        { type: "text", text: "explain {{IMAGE}}" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,abc123" },
        },
      ],
    });
  });

  test("substitutes plain user text as before", () => {
    const result = processUserMessageTemplate(
      visionTemplate,
      "describe the chart"
    );

    expect(result).toEqual({
      role: "user",
      content: [{ type: "text", text: "describe the chart" }],
    });
  });
});

describe("buildDynamicMessages", () => {
  const messagesTemplate = [
    { role: "system", content: "{{SYSTEM_PROMPT}}" },
    visionTemplate,
  ];

  test("keeps literal {{IMAGE}} text through the full message build", () => {
    const result = buildDynamicMessages(
      messagesTemplate,
      [],
      "explain {{IMAGE}}",
      []
    );

    expect(result[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "explain {{IMAGE}}" }],
    });
  });
});
