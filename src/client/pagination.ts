export type PaginationItem = number | "ellipsis";

export function paginationItems(currentPage: number, pageCount: number): PaginationItem[] {
  const visiblePages = new Set([
    1,
    currentPage - 1,
    currentPage,
    currentPage + 1,
    pageCount,
    ...(currentPage <= 2 ? [2, pageCount - 1] : []),
    ...(currentPage >= pageCount - 1 ? [2, pageCount - 1] : []),
  ]);
  const pages = [...visiblePages]
    .filter((page) => page >= 1 && page <= pageCount)
    .sort((left, right) => left - right);

  return pages.flatMap((page, index) => (
    index > 0 && page > pages[index - 1] + 1 ? ["ellipsis", page] : [page]
  ));
}
