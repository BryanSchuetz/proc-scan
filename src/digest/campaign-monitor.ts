export interface CampaignMonitorConfig {
  apiKey: string;
  clientId?: string;
  from: string;
  replyTo?: string;
  recipient: string;
}

export interface DigestMessage {
  subject: string;
  html: string;
  text: string;
}

export class CampaignMonitorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CampaignMonitorError";
  }
}

function endpoint(clientId?: string): string {
  const url = new URL("https://api.createsend.com/api/v3.3/transactional/classicEmail/send");
  if (clientId) url.searchParams.set("clientID", clientId);
  return url.toString();
}

export async function sendCampaignMonitorDigest(
  config: CampaignMonitorConfig,
  message: DigestMessage,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(endpoint(config.clientId), {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${config.apiKey}:x`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Subject: message.subject,
        From: config.from,
        ...(config.replyTo ? { ReplyTo: config.replyTo } : {}),
        To: [config.recipient],
        Html: message.html,
        Text: message.text,
        TrackOpens: false,
        TrackClicks: false,
        InlineCSS: true,
        Group: "Procurement Opportunity Digest",
        ConsentToTrack: "Unchanged",
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CampaignMonitorError(
      "campaign_monitor_unavailable",
      "Campaign Monitor could not be reached.",
      true,
    );
  }

  if (!response.ok) {
    throw new CampaignMonitorError(
      `campaign_monitor_http_${response.status}`,
      `Campaign Monitor rejected the digest with HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500,
    );
  }

  const body: unknown = await response.json().catch(() => undefined);
  const delivery = Array.isArray(body) ? body[0] : undefined;
  if (
    !delivery ||
    typeof delivery !== "object" ||
    !("MessageID" in delivery) ||
    typeof delivery.MessageID !== "string"
  ) {
    throw new CampaignMonitorError(
      "campaign_monitor_invalid_response",
      "Campaign Monitor accepted the request without returning a message ID.",
      true,
    );
  }
  return delivery.MessageID;
}
