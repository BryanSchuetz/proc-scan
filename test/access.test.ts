import { describe, expect, it, vi } from "vitest";
import { authorizeRequest, isAccessFailure } from "../src/worker/access";

describe("Cloudflare Access guard", () => {
  it("allows loopback development without weakening shared hosts", async () => {
    expect(isAccessFailure(await authorizeRequest(new Request("http://localhost/api/events"), {}))).toBe(false);
    expect(
      isAccessFailure(
        await authorizeRequest(new Request("https://preview.onamp.dev/api/events"), {}),
      ),
    ).toBe(false);
    const shared = await authorizeRequest(new Request("https://registry.example.com/api/events"), {});
    expect(shared).toMatchObject({ status: 503, code: "access_not_configured" });
  });

  it("rejects a missing Access JWT", async () => {
    const result = await authorizeRequest(new Request("https://registry.example.com/api/events"), {
      TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      POLICY_AUD: "audience",
    });
    expect(result).toMatchObject({ status: 403, code: "access_token_missing" });
  });

  it("accepts only a token validated for the configured application", async () => {
    const verifier = vi.fn().mockResolvedValue({ sub: "user-1", email: "user@example.com" });
    const result = await authorizeRequest(
      new Request("https://registry.example.com/api/events", {
        headers: { "Cf-Access-Jwt-Assertion": "signed-token" },
      }),
      { TEAM_DOMAIN: "https://team.cloudflareaccess.com", POLICY_AUD: "audience" },
      verifier,
    );
    expect(result).toEqual({ subject: "user-1", email: "user@example.com" });
    expect(verifier).toHaveBeenCalledWith("signed-token", {
      TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      POLICY_AUD: "audience",
    });
  });

  it("does not expose token verification errors", async () => {
    const result = await authorizeRequest(
      new Request("https://registry.example.com/api/events", {
        headers: { "Cf-Access-Jwt-Assertion": "bad-token" },
      }),
      { TEAM_DOMAIN: "https://team.cloudflareaccess.com", POLICY_AUD: "audience" },
      async () => { throw new Error("sensitive verifier detail"); },
    );
    expect(result).toMatchObject({ status: 403, code: "access_token_invalid" });
    expect(JSON.stringify(result)).not.toContain("sensitive verifier detail");
  });
});
