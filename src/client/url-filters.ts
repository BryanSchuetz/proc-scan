export function sourceFilterFromUrl(url: URL): string {
  return url.searchParams.get("filter-source")?.trim().toLocaleLowerCase() ?? "";
}

export function urlWithSourceFilter(url: URL, source: string): URL {
  const nextUrl = new URL(url);
  if (source) nextUrl.searchParams.set("filter-source", source);
  else nextUrl.searchParams.delete("filter-source");
  return nextUrl;
}
