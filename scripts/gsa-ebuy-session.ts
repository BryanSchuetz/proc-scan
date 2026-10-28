// Run only after completing FAS ID/MFA in this orb's Desktop browser.
// --remote writes a Worker secret (and deploys a Worker version): owner approval
// is required. Default: update only the ignored local .dev.vars file.
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { gsaEbuyTokenExpiry, requestGsaEbuy } from "../src/sources/gsa-ebuy";

async function handoff() {
  const remote = process.argv.slice(2).includes("--remote");
  if (process.argv.slice(2).some((arg) => arg !== "--remote")) throw new Error("Use --remote or no arguments.");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_WORKERS_TOKEN;
  if (remote && (!accountId || !apiToken)) {
    throw new Error("Remote handoff requires CLOUDFLARE_ACCOUNT_ID and a Cloudflare API token.");
  }
  const tabs = await fetch("http://localhost:9222/json/list").then((r) => r.json()) as Array<{
    url: string; webSocketDebuggerUrl: string;
  }>;
  const tab = tabs.find((tab) => tab.url.startsWith("https://www.ebuy.gsa.gov/ebuy/seller"));
  if (!tab) throw new Error("Open eBuy and complete contractor sign-in in the Desktop browser first.");
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  const timeout = setTimeout(() => socket.close(), 10_000);
  const session = await new Promise<{ token: string; contractNumber: string }>((resolve, reject) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      id: 1, method: "Runtime.evaluate", params: {
        expression: `(() => {
          const state = JSON.parse(localStorage.getItem("eBuyLoginState") || "null");
          return state?.state === "authenticated" ? {
            token: state.jwtToken,
            contractNumber: state.user.userData.masterContract
          } : null;
        })()`,
        returnByValue: true,
      },
    })));
    socket.addEventListener("message", (message) => {
      const reply = JSON.parse(String(message.data));
      if (reply.id !== 1) return;
      const value = reply.result?.result?.value;
      if (typeof value?.token !== "string" || !/^[A-Za-z0-9-]+$/.test(value?.contractNumber ?? "")) {
        reject(new Error("The browser does not have an authenticated eBuy contractor session."));
      } else resolve(value);
      socket.close();
    });
    socket.addEventListener("error", () => reject(new Error("Could not read the Desktop browser session.")));
    socket.addEventListener("close", () => reject(new Error("The Desktop browser did not provide a session.")));
  }).finally(() => { clearTimeout(timeout); socket.close(); });

  if (gsaEbuyTokenExpiry(session.token) <= Date.now()) {
    throw new Error("The eBuy session has expired. Complete a fresh FAS ID login first.");
  }
  const renewed = await requestGsaEbuy("renew", session.token, AbortSignal.timeout(20_000), fetch, {
    token: session.token,
  }) as { token?: unknown };
  if (typeof renewed.token !== "string" || gsaEbuyTokenExpiry(renewed.token) < Date.now() + 5 * 60_000) {
    throw new Error("GSA did not renew the session. Complete a fresh FAS ID login first.");
  }
  session.token = renewed.token;
  const secret = JSON.stringify(session);
  if (remote) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(".agents/wrangler", ["secret", "put", "GSA_EBUY_SESSION"], {
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin.end(secret);
      child.on("error", () => reject(new Error("Could not start Wrangler.")));
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Worker secret handoff failed.")));
    });

    // Initialize only session renewal, never the procurement-scan workflow.
    const instanceId = crypto.randomUUID();
    const workflowUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/gsa-ebuy-session/instances`;
    const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
    const queued = await fetch(workflowUrl, {
      method: "POST", headers, body: JSON.stringify({ instance_id: instanceId }), signal: AbortSignal.timeout(20_000),
    });
    const created = await queued.json() as { success?: boolean };
    if (!queued.ok || !created.success) {
      throw new Error("Secret updated, but session initialization could not be queued. Deploy the gsa-ebuy-session workflow and initialize it before the token expires; do not run a scan.");
    }
    const deadline = Date.now() + 120_000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      const response = await fetch(`${workflowUrl}/${instanceId}`, { headers, signal: AbortSignal.timeout(20_000) });
      const state = await response.json() as { success?: boolean; result?: { status?: string } };
      if (!response.ok || !state.success) {
        throw new Error(`Secret updated, but initialization status is unknown. Check gsa-ebuy-session instance ${instanceId}; do not run a scan.`);
      }
      status = state.result?.status;
      if (status === "complete") break;
      if (status === "errored" || status === "terminated") {
        throw new Error(`Session initialization failed. Check gsa-ebuy-session instance ${instanceId}; do not run a scan.`);
      }
      await sleep(2_000);
    }
    if (status !== "complete") {
      throw new Error(`Session initialization is not confirmed. Check gsa-ebuy-session instance ${instanceId}; do not run a scan.`);
    }
  } else {
    const current = await readFile(".dev.vars", "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const other = current.split("\n").filter((line) => !/^\s*GSA_EBUY_SESSION\s*=/.test(line)).join("\n").trimEnd();
    await writeFile(".dev.vars", `${other}\nGSA_EBUY_SESSION=${secret}\n`, { mode: 0o600 });
  }
  console.log(`GSA eBuy session handed off to ${remote ? "the Worker secret" : "local .dev.vars"}; no credentials printed.`);
  console.log(remote
    ? "Automatic renewal initialized. No scan or digest was triggered; the next scheduled scan will use this session."
    : "With the local Worker running, initialize renewal within 30 minutes: .agents/wrangler workflows trigger gsa-ebuy-session --local. Do not run a scan for token handoff.");
}

handoff().catch((error) => {
  // Only our credential-safe messages are exposed. No protocol/network bodies.
  console.error(error instanceof Error && (error.name === "Error" || error.name === "SourceScanError")
    ? error.message : "GSA eBuy session handoff failed.");
  process.exitCode = 1;
});
