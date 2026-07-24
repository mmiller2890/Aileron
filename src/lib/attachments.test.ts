import { describe, expect, test } from "vitest";
import {
  appendWithinLimit,
  selectImageFilesWithinLimit,
} from "./attachments";

const image = (name: string) => ({ name, type: "image/png" });
const text = (name: string) => ({ name, type: "text/plain" });

describe("selectImageFilesWithinLimit", () => {
  test("selects at most six images from a larger batch", () => {
    const files = Array.from({ length: 10 }, (_, index) =>
      image(`image-${index}`)
    );

    expect(selectImageFilesWithinLimit(files, 0)).toHaveLength(6);
  });

  test("uses only the capacity remaining after existing files", () => {
    const files = [image("a"), image("b"), image("c")];

    expect(
      selectImageFilesWithinLimit(files, 4).map((file) => file.name)
    ).toEqual(["a", "b"]);
  });

  test("filters non-image files before applying the cap", () => {
    const files = [text("notes"), image("a"), text("data"), image("b")];

    expect(
      selectImageFilesWithinLimit(files, 0).map((file) => file.name)
    ).toEqual(["a", "b"]);
  });

  test("returns no files when capacity is exhausted", () => {
    expect(selectImageFilesWithinLimit([image("a")], 6)).toEqual([]);
    expect(selectImageFilesWithinLimit([image("a")], 7)).toEqual([]);
  });
});

describe("appendWithinLimit", () => {
  test("never exceeds the cap across overlapping async results", () => {
    const first = appendWithinLimit(
      [image("existing")],
      Array.from({ length: 4 }, (_, index) => image(`first-${index}`))
    );
    const second = appendWithinLimit(
      first,
      Array.from({ length: 4 }, (_, index) => image(`second-${index}`))
    );

    expect(second).toHaveLength(6);
    expect(second.map((file) => file.name)).toEqual([
      "existing",
      "first-0",
      "first-1",
      "first-2",
      "first-3",
      "second-0",
    ]);
  });
});
