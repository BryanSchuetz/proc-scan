// Run only after completing FAS ID/MFA in this orb's Desktop browser.
// --remote writes a Worker secret (and deploys a Worker version): owner approval
// is required. Default: update only the ignored local .dev.vars file.
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { gsaEbuyTokenExpiry, requestGsaEbuy } from "../src/sources/gsa-ebuy";

async function handoff() {
  const remote = process.argv.slice(2).includes("--remote");
  if (process.argv.slice(2).some((arg) => arg !== "--remote")) throw new Error("Use --remote or no arguments.");
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
  } else {
    const current = await readFile(".dev.vars", "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const other = current.split("\n").filter((line) => !/^\s*GSA_EBUY_SESSION\s*=/.test(line)).join("\n").trimEnd();
    await writeFile(".dev.vars", `${other}\nGSA_EBUY_SESSION=${secret}\n`, { mode: 0o600 });
  }
  console.log(`GSA eBuy session handed off to ${remote ? "the Worker secret" : "local .dev.vars"}; no credentials printed.`);
  console.log("Run the first approved scan before the token expires (within 30 minutes) to start automatic renewal.");
}

handoff().catch((error) => {
  // Only our credential-safe messages are exposed. No protocol/network bodies.
  console.error(error instanceof Error && (error.name === "Error" || error.name === "SourceScanError")
    ? error.message : "GSA eBuy session handoff failed.");
  process.exitCode = 1;
});
