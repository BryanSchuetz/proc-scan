import { describe, expect, it } from "vitest";
import { sourceFilterFromUrl, urlWithSourceFilter } from "../src/client/url-filters";

describe("registry URL filters", () => {
  it("reads the source filter case-insensitively for the source ID query", () => {
    const url = new URL("https://registry.example/?filter-source=TED");

    expect(sourceFilterFromUrl(url)).toBe("ted");
  });

  it("sets and clears the source filter without dropping other URL state", () => {
    const url = new URL("https://registry.example/unmarked?view=compact#results");
    const filtered = urlWithSourceFilter(url, "ted");

    expect(filtered.href).toBe(
      "https://registry.example/unmarked?view=compact&filter-source=ted#results",
    );
    expect(urlWithSourceFilter(filtered, "").href).toBe(
      "https://registry.example/unmarked?view=compact#results",
    );
  });
});
