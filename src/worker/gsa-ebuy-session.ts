import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { SourceScanError } from "../sources/adapter";
import {
  gsaEbuyReauthenticationRequired,
  gsaEbuyTokenExpiry,
  requestGsaEbuy,
  type GsaEbuySession,
} from "../sources/gsa-ebuy";

const sessionSchema = z.object({
  token: z.string().min(1),
  contractNumber: z.string().regex(/^[A-Za-z0-9-]+$/),
});
interface StoredSession {
  seedDigest: string;
  ciphertext?: ArrayBuffer;
  iv?: Uint8Array<ArrayBuffer>;
}

// Private binding only: no public Worker route exposes this object or its token.
// A new secret handoff replaces a revoked/expired session. No passwords or MFA
// codes are stored, and a failed session is never resurrected from the old seed.
export class GsaEbuySessionHolder extends DurableObject<{ GSA_EBUY_SESSION?: string }> {
  private async session(renew: boolean): Promise<GsaEbuySession> {
    const seed = this.env.GSA_EBUY_SESSION;
    if (!seed) throw gsaEbuyReauthenticationRequired();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
    // Store only a fingerprint of the encryption key, never the key itself.
    const seedDigest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", digest))));
    const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
    const stored = await this.ctx.storage.get<StoredSession>("session");
    let session: GsaEbuySession;
    let bootstrap = false;
    try {
      if (stored?.seedDigest === seedDigest) {
        if (!stored.ciphertext || !stored.iv) throw gsaEbuyReauthenticationRequired();
        const cleartext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: stored.iv }, key, stored.ciphertext);
        session = sessionSchema.parse(JSON.parse(new TextDecoder().decode(cleartext)));
      } else {
        session = sessionSchema.parse(JSON.parse(seed));
        bootstrap = true;
      }
      if (gsaEbuyTokenExpiry(session.token) <= Date.now()) throw gsaEbuyReauthenticationRequired();
    } catch {
      await this.ctx.storage.put("session", { seedDigest });
      await this.ctx.storage.deleteAlarm();
      throw gsaEbuyReauthenticationRequired();
    }

    if (bootstrap || renew || gsaEbuyTokenExpiry(session.token) - Date.now() < 5 * 60_000) {
      try {
        const response = await requestGsaEbuy("renew", session.token, AbortSignal.timeout(20_000), fetch, {
          token: session.token,
        });
        const result = z.object({ token: z.string() }).safeParse(response);
        if (!result.success || gsaEbuyTokenExpiry(result.data.token) <= Date.now() + 60_000) {
          throw gsaEbuyReauthenticationRequired();
        }
        session.token = result.data.token;
      } catch (error) {
        if (error instanceof SourceScanError && error.retryable) {
          await this.ctx.storage.setAlarm(Date.now() + 60_000);
          throw error;
        }
        await this.ctx.storage.put("session", { seedDigest });
        await this.ctx.storage.deleteAlarm();
        throw gsaEbuyReauthenticationRequired();
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(session)),
      );
      await this.ctx.storage.put("session", { seedDigest, ciphertext, iv });
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 60_000, gsaEbuyTokenExpiry(session.token) - 5 * 60_000));
    return session;
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/session" || request.method !== "GET") {
      return new Response(null, { status: 404 });
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        return Response.json(await this.session(false), { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const failure = error instanceof SourceScanError ? error : gsaEbuyReauthenticationRequired();
        return Response.json({ code: failure.code, message: failure.message, retryable: failure.retryable }, {
          status: 503, headers: { "Cache-Control": "no-store" },
        });
      }
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.session(true);
      } catch (error) {
        // Safe operational signal; scans also record the failure in source_runs
        // and existing nonempty digests report incomplete Source coverage.
        console.warn("GSA eBuy session:", error instanceof SourceScanError ? error.code : "session_unavailable");
      }
    });
  }
}

// Cloudflare's authenticated Workflows API is the only entry point. Session
// initialization has no scan or digest steps, and never persists a token output.
export class GsaEbuySessionWorkflow extends WorkflowEntrypoint<{ GSA_EBUY_AUTH: DurableObjectNamespace }> {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return step.do("initialize eBuy session renewal", {
      retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
      timeout: "1 minute",
    }, async () => {
      const holder = this.env.GSA_EBUY_AUTH.get(this.env.GSA_EBUY_AUTH.idFromName("gsa-ebuy"));
      const response = await holder.fetch("https://session/session");
      if (!response.ok) {
        const failure = await response.json<{ code: string; retryable: boolean }>();
        if (!failure.retryable) throw new NonRetryableError(failure.code);
        throw new Error(failure.code);
      }
      await response.body?.cancel();
      return { status: "ready" };
    });
  }
}
