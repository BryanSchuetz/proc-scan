import puppeteer from "@cloudflare/puppeteer";
import { SourceScanError } from "./adapter";

export interface BrowserPageSession {
  load(url: URL, readySelector: string): Promise<Response>;
  close(): Promise<void>;
}

export type BrowserPageSessionFactory = (
  signal: AbortSignal,
) => Promise<BrowserPageSession>;

export function createBrowserPageSessionFactory(
  binding: Fetcher,
  sourceName: string,
): BrowserPageSessionFactory {
  return async (signal) => {
    let browser;
    try {
      browser = await puppeteer.launch(binding, { keep_alive: 120_000 });
    } catch {
      throw new SourceScanError(
        "browser_unavailable",
        `${sourceName} could not start its browser session.`,
        true,
      );
    }

    const close = async () => {
      try {
        await browser.close();
      } catch {
        // The browser may already have closed after an abort or platform timeout.
      }
    };
    const onAbort = () => void close();
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(45_000);
      return {
        async load(url, readySelector) {
          try {
            await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
            await page.waitForSelector(readySelector, { timeout: 30_000 });
            const html = await page.content();
            return new Response(html, {
              headers: { "content-type": "text/html;charset=UTF-8" },
            });
          } catch {
            const title = await page.title().catch(() => "");
            if (/just a moment|attention required/i.test(title)) {
              throw new SourceScanError(
                "browser_challenge",
                `${sourceName} did not allow the browser session through its access challenge.`,
                true,
              );
            }
            throw new SourceScanError(
              "browser_navigation_failed",
              `${sourceName} did not render the expected public page.`,
              true,
            );
          }
        },
        async close() {
          signal.removeEventListener("abort", onAbort);
          await close();
        },
      };
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      await close();
      if (error instanceof SourceScanError) throw error;
      throw new SourceScanError(
        "browser_unavailable",
        `${sourceName} could not initialize its browser page.`,
        true,
      );
    }
  };
}
