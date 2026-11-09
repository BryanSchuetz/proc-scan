import type { PluginAPI } from "@ampcode/plugin";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GsaCodeInbox } from "./gsa-ebuy-inbox/inbox";

export const description = "Receives Zapier-forwarded GSA verification codes for a pending login; never exposes codes to agent tools.";

export default async function (amp: PluginAPI) {
  if (!amp.system.workspaceRoot) return;
  const root = amp.helpers.filePathFromURI(amp.system.workspaceRoot);
  const directory = join(root, ".amp/gsa-ebuy-private");
  const inbox = new GsaCodeInbox(directory);
  const timer = setInterval(() => inbox.cleanup(), 30_000);
  amp.onDispose(() => { clearInterval(timer); inbox.close(); });
  const { url } = await amp.createWebhook({
    key: "gsa-ebuy-code",
    headers: ["authorization"],
    handler(event, ctx) {
      ctx.signal.throwIfAborted();
      // Do not log payloads or propagate parser errors containing email text.
      inbox.receive(event, event.headers.authorization);
    },
  });
  const setupPath = join(directory, "zapier-setup.json");
  writeFileSync(setupPath, JSON.stringify({
    url,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${inbox.token}` },
    payloadFields: {
      sender: "MFA-No-Reply+noreply@gsa.gov",
      subject: "GSA FAS ID one-time verification code",
      body: "MAP: original plain-text email body",
      message_id: "MAP: original email message ID (stable across Zapier retries)",
      sent_at: "MAP: original email sent date as an ISO 8601 timestamp, not Zap run time",
    },
  }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(setupPath, 0o600);
  amp.registerTool({
    name: "gsa_code_inbox_status",
    description: "Returns safe GSA code inbox readiness and delivery outcome. Never returns codes, email content, webhook URL, or credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return JSON.stringify(inbox.status()); },
  });
}
