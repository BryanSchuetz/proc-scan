import { describe, expect, it } from "vitest";
import { paginationItems } from "../src/client/pagination";

describe("paginationItems", () => {
  it("shows every page when the range is short", () => {
    expect(paginationItems(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("keeps the current page visible between the first and last pages", () => {
    expect(paginationItems(50, 100)).toEqual([1, "ellipsis", 49, 50, 51, "ellipsis", 100]);
  });

  it("collapses only the distant range at either boundary", () => {
    expect(paginationItems(1, 100)).toEqual([1, 2, "ellipsis", 99, 100]);
    expect(paginationItems(100, 100)).toEqual([1, 2, "ellipsis", 99, 100]);
  });
});
