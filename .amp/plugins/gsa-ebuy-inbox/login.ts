// Run with Bun in the webhook-owning orb. Default handoff is local only;
// --remote updates the deployed Worker and requires explicit owner approval.
import puppeteer, { type Page } from "@cloudflare/puppeteer/internal/puppeteer-core.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { GsaCodeInbox } from "./inbox";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const EBUY = "https://www.ebuy.gsa.gov";
const FAS = "https://mfalogin.fas.gsa.gov";

async function waitForStep(page: Page, selector: string, origin: string) {
  await page.waitForSelector(selector, { visible: true, timeout: 45_000 });
  if (new URL(page.url()).origin !== origin) throw new Error("Unexpected login origin; stopped before entering credentials.");
}

export async function completeGsaLogin(page: Page, inbox: GsaCodeInbox, credentials: { username: string; password: string }) {
  let attemptId: string | undefined;
  try {
    console.log("Opening the GSA contractor sign-in page.");
    await page.goto(`${EBUY}/ebuy/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForFunction(() => [...document.querySelectorAll("button")]
      .some((item) => item.textContent?.trim() === "Contractor"), { timeout: 45_000 });
    await waitForStep(page, "button", EBUY);
    // This is the observed contractor sign-in control, not the buyer login.
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Contractor");
      if (!button) throw new Error("Contractor sign-in control missing.");
      button.click();
    });
    await waitForStep(page, "#okta-signin-username", FAS);
    console.log("Official FAS ID form ready; submitting credentials privately.");
    await page.type("#okta-signin-username", credentials.username);
    await page.type("#okta-signin-password", credentials.password);
    await page.click("#okta-signin-submit");
    console.log("Credentials submitted; waiting for the email verification step.");
    await waitForStep(page, 'input[type="submit"][value="Send me the code"]', FAS);
    // Begin only immediately before requesting this email. Never resend or guess.
    const attempt = inbox.begin();
    attemptId = attempt.attemptId;
    await page.click('input[type="submit"][value="Send me the code"]');
    await waitForStep(page, 'input[name="answer"]', FAS);
    console.log("GSA email requested; waiting for the Zapier webhook.");
    let code: string | null = null;
    while (Date.now() < Date.parse(attempt.expiresAt)) {
      code = inbox.take(attemptId);
      if (code) break;
      if (!inbox.status().pending) break;
      await Bun.sleep(1_000);
    }
    if (!code) throw new Error("No matching fresh code arrived before the login deadline. Check safe inbox status and Zapier delivery.");
    // Recheck origin immediately before sending the secret to the browser.
    await waitForStep(page, 'input[name="answer"]', FAS);
    await page.type('input[name="answer"]', code);
    code = null;
    await page.click('input[type="submit"][value="Verify"]');
    await page.waitForFunction(() => {
      if (location.origin !== "https://www.ebuy.gsa.gov" || !location.pathname.startsWith("/ebuy/seller")) return false;
      const state = JSON.parse(localStorage.getItem("eBuyLoginState") || "null");
      return state?.state === "authenticated" && typeof state.jwtToken === "string";
    }, { timeout: 60_000 });
    console.log("GSA browser login verified; code was not exposed to agent output.");
  } finally {
    if (attemptId) inbox.cancel(attemptId);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--remote")) throw new Error("Use --remote or no arguments.");
  const remote = args.includes("--remote");
  if (!process.env.GSA_USER || !process.env.GSA_PW) throw new Error("GSA_USER and GSA_PW must be supplied privately.");
  if (remote && (!process.env.CLOUDFLARE_ACCOUNT_ID || !(process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_WORKERS_TOKEN))) {
    throw new Error("Remote handoff requires Cloudflare account and token configuration.");
  }
  const inbox = new GsaCodeInbox(resolve(ROOT, ".amp/gsa-ebuy-private"));
  const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await completeGsaLogin(page, inbox, { username: process.env.GSA_USER, password: process.env.GSA_PW });
    const client = await page.createCDPSession();
    const { targetInfo } = await client.send("Target.getTargetInfo");
    await client.detach();
    const handoffArgs = ["tsx", "scripts/gsa-ebuy-session.ts", `--tab-id=${targetInfo.targetId}`];
    if (remote) handoffArgs.push("--remote");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("npx", handoffArgs, { cwd: ROOT, stdio: "inherit" });
      child.once("error", () => reject(new Error("Could not start session handoff.")));
      child.once("exit", (status) => status === 0 ? resolve() : reject(new Error("Session handoff failed; check its safe status above.")));
    });
  } finally {
    await context.close();
    await browser.disconnect();
    inbox.close();
  }
}

if (import.meta.main) {
  main().catch(() => {
    // Browser/protocol errors may contain input values or page content. Do not
    // print their messages, stacks, HTML, URLs with queries, or request bodies.
    console.error("GSA login/handoff did not complete. Check safe inbox status; no scan or digest was requested.");
    process.exitCode = 1;
  });
}
