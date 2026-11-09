// Requires the orb Desktop Chrome on port 9222. All page requests are intercepted;
// these tests never send credentials to GSA or update Cloudflare.
import { expect, test } from "bun:test";
import puppeteer from "@cloudflare/puppeteer/internal/puppeteer-core.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GsaCodeInbox } from "./inbox";
import { completeGsaLogin } from "./login";

test.each([false, true])("browser login consumes the delivered code and refuses foreign origins (foreign: %s)", async (foreign) => {
  const directory = mkdtempSync(join(tmpdir(), "gsa-browser-test-"));
  const inbox = new GsaCodeInbox(directory);
  const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const url = new URL(request.url());
      let html: string;
      if (url.pathname === "/ebuy/") {
        const origin = foreign ? "https://foreign.example" : "https://mfalogin.fas.gsa.gov";
        html = `<button onclick="location.href='${origin}/'">Contractor</button>`;
      } else if (url.pathname === "/") {
        html = `<form onsubmit="event.preventDefault();if(document.querySelector('#okta-signin-username').value==='fixture-user' && document.querySelector('#okta-signin-password').value==='fixture-password')location.href='/send'">
          <input id="okta-signin-username"><input id="okta-signin-password" type="password"><input id="okta-signin-submit" type="submit"></form>`;
      } else if (url.pathname === "/send") {
        html = `<input type="submit" value="Send me the code" onclick="location.href='/code'">`;
      } else if (url.pathname === "/code") {
        inbox.receive({ id: "fixture-event", receivedAt: new Date().toISOString(), body: Buffer.from(JSON.stringify({
          sender: "MFA-No-Reply+noreply@gsa.gov", subject: "GSA FAS ID one-time verification code",
          body: "Please enter the following code for verification:\n682715\nHelp desk 1-877-472-3777",
          message_id: "fixture-message", sent_at: new Date().toISOString(),
        })) }, `Bearer ${inbox.token}`);
        html = `<form onsubmit="event.preventDefault();if(document.querySelector('input[name=answer]').value==='682715')location.href='https://www.ebuy.gsa.gov/ebuy/seller/test'">
          <input name="answer"><input type="submit" value="Verify"></form>`;
      } else if (url.pathname === "/ebuy/seller/test") {
        html = `<script>localStorage.setItem('eBuyLoginState', JSON.stringify({state:'authenticated', jwtToken:'fixture-token'}))</script><h1>Fixture login complete</h1>`;
      } else {
        await request.abort(); return;
      }
      await request.respond({ status: 200, contentType: "text/html", body: html });
    });
    const result = completeGsaLogin(page, inbox, { username: "fixture-user", password: "fixture-password" });
    if (foreign) {
      await expect(result).rejects.toThrow("Unexpected login origin");
      expect(await page.$eval("#okta-signin-username", (el) => (el as HTMLInputElement).value)).toBe("");
      expect(await page.$eval("#okta-signin-password", (el) => (el as HTMLInputElement).value)).toBe("");
    } else {
      await result;
      expect(page.url()).toBe("https://www.ebuy.gsa.gov/ebuy/seller/test");
      expect(inbox.status()).toMatchObject({ pending: false, codeReady: false, lastDelivery: { outcome: "accepted" } });
    }
  } finally {
    await context.close();
    await browser.disconnect();
    inbox.close();
    rmSync(directory, { recursive: true });
  }
}, 30_000);
