import { describe, it, expect } from "vitest";
import { extractVariables } from "./common.function";

describe("extractVariables", () => {
  it("extracts plain uppercase placeholders", () => {
    expect(
      extractVariables("curl -H 'Authorization: Bearer {{API_KEY}}'"),
    ).toEqual([{ key: "API_KEY", value: "API_KEY" }]);
  });

  it("extracts placeholders containing digits", () => {
    // deepVariableReplacer substitutes any key in the variable map, so a
    // digit-bearing placeholder is filled in at request time; missing it here
    // meant the UI never asked the user to configure it.
    expect(
      extractVariables("curl -H 'X-Key: {{API_KEY2}}' -d '{{PROJECT_ID}}'"),
    ).toEqual([
      { key: "API_KEY2", value: "API_KEY2" },
      { key: "PROJECT_ID", value: "PROJECT_ID" },
    ]);
  });

  it("still omits the runtime-supplied placeholders by default", () => {
    expect(
      extractVariables(
        "{{TEXT}} {{IMAGE}} {{AUDIO}} {{SYSTEM_PROMPT}} {{MODEL}}",
      ),
    ).toEqual([{ key: "MODEL", value: "MODEL" }]);
  });

  it("includes the runtime-supplied placeholders when asked", () => {
    expect(extractVariables("{{TEXT}} {{MODEL}}", true)).toEqual([
      { key: "TEXT", value: "TEXT" },
      { key: "MODEL", value: "MODEL" },
    ]);
  });

  it("returns nothing for a non-string curl", () => {
    expect(extractVariables(undefined as never)).toEqual([]);
  });
});
