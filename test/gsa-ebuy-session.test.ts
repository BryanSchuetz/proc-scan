import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

const token = (minutes: number) => `fixture.${btoa(JSON.stringify({ exp: Date.now() / 1000 + minutes * 60 }))}.signature`;

afterEach(() => { vi.unstubAllGlobals(); });

describe("private eBuy session handoff", () => {
  it("renews through GSA, encrypts stored material, and renews again on its alarm", async () => {
    const holder = env.GSA_EBUY_AUTH.get(env.GSA_EBUY_AUTH.newUniqueId());
    const first = token(30);
    vi.stubGlobal("fetch", async () => Response.json({ header: { status: 0 }, response: { token: first } }));
    const response = await holder.fetch("https://session/session");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: first, contractNumber: "GS-TEST" });
    await runInDurableObject(holder, async (_instance, state) => {
      const stored = await state.storage.get<{ seedDigest: string; ciphertext: ArrayBuffer; iv: Uint8Array<ArrayBuffer> }>("session");
      expect(JSON.stringify(stored)).not.toContain(first);
      expect(stored).toHaveProperty("ciphertext");
      // A storage-only reader must not be able to use the rotation fingerprint
      // as the encryption key.
      const fingerprintKey = await crypto.subtle.importKey("raw", Uint8Array.from(atob(stored!.seedDigest), (c) => c.charCodeAt(0)), "AES-GCM", false, ["decrypt"]);
      await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv: stored!.iv }, fingerprintKey, stored!.ciphertext)).rejects.toThrow();
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThan(Date.now() + 24 * 60_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 25 * 60_000);
    });
    expect(await (await holder.fetch("https://session/session")).json()).toEqual({ token: first, contractNumber: "GS-TEST" });
    const second = token(40);
    vi.stubGlobal("fetch", async () => Response.json({ header: { status: 0 }, response: { token: second } }));
    await runDurableObjectAlarm(holder);
    expect(await (await holder.fetch("https://session/session")).json()).toEqual({ token: second, contractNumber: "GS-TEST" });
  });

  it("stops renewal on rejection and never resurrects a rejected bootstrap token", async () => {
    const holder = env.GSA_EBUY_AUTH.get(env.GSA_EBUY_AUTH.newUniqueId());
    vi.stubGlobal("fetch", async () => new Response(null, { status: 403 }));
    for (let i = 0; i < 2; i++) {
      const response = await holder.fetch("https://session/session");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "reauthentication_required", retryable: false });
    }
    await runInDurableObject(holder, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("retries a transient renewal failure without discarding the valid session", async () => {
    const holder = env.GSA_EBUY_AUTH.get(env.GSA_EBUY_AUTH.newUniqueId());
    const first = token(30);
    vi.stubGlobal("fetch", async () => Response.json({ header: { status: 0 }, response: { token: first } }));
    expect((await holder.fetch("https://session/session")).status).toBe(200);
    vi.stubGlobal("fetch", async () => { throw new TypeError("network unavailable"); });
    await runDurableObjectAlarm(holder);
    await runInDurableObject(holder, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 60_000);
    });
    expect(await (await holder.fetch("https://session/session")).json()).toEqual({ token: first, contractNumber: "GS-TEST" });
  });
});
