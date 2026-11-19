import { describe, expect, it } from "vitest";
import { toExternalHref } from "./external-href";

describe("toExternalHref", () => {
  it.each([
    ["https://forum.aztec.network/t/x/1", "https://forum.aztec.network/t/x/1"],
    ["http://example.com/a", "http://example.com/a"],
  ])("keeps the http(s) URL %s", (value, href) => {
    expect(toExternalHref(value)).toBe(href);
  });

  it.each([
    ["a javascript: URL", "javascript:alert(1)"],
    [
      "a mixed-case scheme after control characters",
      "\u0001 JavaScript:alert(1)",
    ],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["a protocol-relative URL", "//example.com/a"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
  ])("returns no href for %s", (_case, value) => {
    expect(toExternalHref(value)).toBeUndefined();
  });
});
