import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import seedSql from "../fixtures/seed.sql?raw";
import type { EventsResponse } from "../src/api/types";
import { findPriorBiddingEvent, updateRetainedBiddingEvent } from "../src/db/events";
import { prepareDigest } from "../src/db/digests";
import * as access from "../src/worker/access";
import worker from "../src/worker/index";

beforeAll(async () => {
  for (const statement of seedSql.split(/;\s*(?:\n|$)/).map((sql) => sql.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare(`UPDATE bidding_events SET manual_addressability_status = NULL,
    manually_marked_by = NULL, manually_marked_at = NULL, due_date = '2099-12-31T00:00:00.000Z'`).run();
});
afterEach(() => vi.restoreAllMocks());

function statusRequest(id: string, status: unknown, origin = "http://localhost") {
  return new Request(`http://localhost/api/admin/opportunities/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ status }),
  });
}

async function list(status: string) {
  return (await SELF.fetch(`http://localhost/api/opportunities?status=${status}`)).json<EventsResponse>();
}

describe("admin marking", () => {
  it("moves an event both ways without moving sibling events or changing its automated assessment", async () => {
    const id = "evt_fixture_digital_tender";
    expect((await SELF.fetch(statusRequest(id, "uncertain"))).status).toBe(200);
    expect((await list("uncertain")).items.map((item) => item.id)).toContain(id);
    const marked = (await list("addressable")).items.map((item) => item.id);
    expect(marked).not.toContain(id);
    expect(marked).toContain("evt_fixture_digital_modification");
    expect(await env.DB.prepare(`SELECT addressability_status, addressability_score,
      manual_addressability_status, manually_marked_by, manually_marked_at FROM bidding_events WHERE id = ?`)
      .bind(id).first()).toMatchObject({
        addressability_status: "addressable", addressability_score: 14,
        manual_addressability_status: "uncertain", manually_marked_by: "local-preview",
        manually_marked_at: expect.any(String),
      });
    expect((await SELF.fetch(statusRequest(id, "addressable"))).status).toBe(200);
    expect((await list("addressable")).items.map((item) => item.id)).toContain(id);
    expect((await list("uncertain")).items.map((item) => item.id)).not.toContain(id);
  });

  it("preserves manual marking through the scan enrichment update path", async () => {
    const id = "evt_fixture_unclassified_tender";
    expect((await SELF.fetch(statusRequest(id, "addressable"))).status).toBe(200);
    const { exactEvent: prior } = await findPriorBiddingEvent(env.DB, "ted", "id:TED-2026-88002");
    expect(prior).toBeDefined();
    await updateRetainedBiddingEvent(env.DB, id, {
      ...prior!, id, scanRunId: "scan_fixture_2026_08_26_am",
      ocdsRelease: { ocid: "fixture", id: "fixture", date: "2026-08-26", tag: ["tender"], initiationType: "tender", tender: { title: prior!.opportunityName } },
      inheritedFields: [], technicalAreas: [], technicalClassificationVersion: 1,
      addressability: { ...prior!.addressability, status: "uncertain", configVersion: 99 },
    });
    expect((await list("addressable")).items.find((item) => item.id === id)?.addressabilityStatus).toBe("addressable");
    expect(await env.DB.prepare("SELECT addressability_status, addressability_config_version, manual_addressability_status FROM bidding_events WHERE id = ?")
      .bind(id).first()).toEqual({ addressability_status: "uncertain", addressability_config_version: 99, manual_addressability_status: "addressable" });
  });

  it("uses effective marking status when preparing a new digest", async () => {
    await SELF.fetch(statusRequest("evt_fixture_agriculture_tender", "uncertain"));
    await SELF.fetch(statusRequest("evt_fixture_health_tender", "addressable"));
    const digest = await prepareDigest(env.DB, "scan_fixture_2026_08_26_am");
    expect(digest.events.map((event) => event.id)).toContain("evt_fixture_health_tender");
    expect(digest.events.map((event) => event.id)).not.toContain("evt_fixture_agriculture_tender");
  });

  it("rejects invalid status, cross-origin writes, missing events, expired events, and unsupported methods", async () => {
    const id = "evt_fixture_digital_tender";
    expect((await SELF.fetch(statusRequest(id, "excluded"))).status).toBe(400);
    expect((await SELF.fetch(statusRequest(id, "uncertain", "https://attacker.test"))).status).toBe(403);
    expect((await SELF.fetch(statusRequest("missing", "uncertain"))).status).toBe(404);
    expect((await SELF.fetch(`http://localhost/api/admin/opportunities/${id}/status`)).status).toBe(405);
    await env.DB.prepare("UPDATE bidding_events SET due_date = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(id).run();
    expect((await SELF.fetch(statusRequest(id, "uncertain"))).status).toBe(404);
    expect(await env.DB.prepare("SELECT manual_addressability_status FROM bidding_events WHERE id = ?").bind(id).first())
      .toEqual({ manual_addressability_status: null });
  });

  it("cannot change hidden disabled-Source events, but can change visible uploads from that Source", async () => {
    const id = "evt_fixture_agriculture_tender";
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = 'ted'").run();
    try {
      expect((await SELF.fetch(statusRequest(id, "uncertain"))).status).toBe(404);
      await env.DB.prepare("UPDATE bidding_events SET source_data_json = ? WHERE id = ?")
        .bind(JSON.stringify({ fixture: true, upload: { id: "upload-fixture" } }), id).run();
      expect((await SELF.fetch(statusRequest(id, "uncertain"))).status).toBe(200);
      expect((await list("uncertain")).items.map((item) => item.id)).toContain(id);
    } finally {
      await env.DB.prepare("UPDATE sources SET enabled = 1 WHERE id = 'ted'").run();
      await env.DB.prepare("UPDATE bidding_events SET source_data_json = '{\"fixture\":true}' WHERE id = ?").bind(id).run();
    }
  });

  it.each(["admin@dai.com", ""])("denies non-admins at admin and upload routes with allowlist %j", async (adminEmails) => {
    vi.spyOn(access, "authorizeRequest").mockResolvedValue({ email: "reader@dai.com" });
    const config = { ...env, BROWSER: env.ASSETS, ADMIN_EMAILS: adminEmails };
    const uploadsBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunity_uploads").first();
    for (const [path, method] of [
      ["/admin", "GET"], ["/admin/", "GET"],
      ["/api/admin/opportunities/evt_fixture_digital_tender/status", "PATCH"],
      ["/upload", "GET"], ["/upload/", "GET"], ["/upload", "HEAD"],
      ["/api/uploads", "GET"], ["/api/uploads", "POST"],
      ["/api/uploads/template", "GET"], ["/api/uploads/", "GET"],
    ]) {
      const response = await worker.fetch(new Request(`https://registry.example.com${path}`, { method }), config);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "admin_required" } });
    }
    const session = await worker.fetch(new Request("https://registry.example.com/api/session"), config);
    expect(await session.json()).toEqual({ isAdmin: false });
    expect(await env.DB.prepare("SELECT manual_addressability_status FROM bidding_events WHERE id = 'evt_fixture_digital_tender'").first())
      .toEqual({ manual_addressability_status: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunity_uploads").first()).toEqual(uploadsBefore);
  });

  it("allows verified admins to list uploads, download the template, and submit files", async () => {
    vi.spyOn(access, "authorizeRequest").mockResolvedValue({ email: "ADMIN@dai.com" });
    const config = { ...env, BROWSER: env.ASSETS, ADMIN_EMAILS: "other@dai.com, admin@dai.com" };
    const history = await worker.fetch(new Request("https://registry.example.com/api/uploads"), config);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ sources: expect.any(Array), uploads: expect.any(Array) });
    const template = await worker.fetch(new Request("https://registry.example.com/api/uploads/template"), config);
    expect(template.status).toBe(200);
    expect(template.headers.get("Content-Disposition")).toContain("opportunities-template.xlsx");
    const body = new FormData();
    body.set("sourceId", "ted");
    body.set("file", new File(["Title,URL\nAdmin upload,https://example.org/admin-upload"], "admin.csv"));
    const response = await worker.fetch(new Request("https://registry.example.com/api/uploads", {
      method: "POST", headers: { Origin: "https://registry.example.com" }, body,
    }), config);
    expect(response.status).toBe(201);
    const upload = await response.json() as { id: string; rowCount: number };
    expect(upload.rowCount).toBe(1);
    expect(await env.DB.prepare("SELECT uploaded_by FROM opportunity_uploads WHERE id = ?").bind(upload.id).first())
      .toEqual({ uploaded_by: "ADMIN@dai.com" });
  });

  it("accepts an allowlisted verified admin and records their identity", async () => {
    vi.spyOn(access, "authorizeRequest").mockResolvedValue({ email: "admin@dai.com" });
    const config = { ...env, BROWSER: env.ASSETS, ADMIN_EMAILS: "admin@dai.com" };
    const response = await worker.fetch(new Request("https://registry.example.com/api/admin/opportunities/evt_fixture_digital_tender/status", {
      method: "PATCH", headers: { "Content-Type": "application/json", Origin: "https://registry.example.com" },
      body: JSON.stringify({ status: "uncertain" }),
    }), config);
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT manually_marked_by FROM bidding_events WHERE id = 'evt_fixture_digital_tender'").first())
      .toEqual({ manually_marked_by: "admin@dai.com" });
    const session = await worker.fetch(new Request("https://registry.example.com/api/session"), config);
    expect(await session.json()).toEqual({ isAdmin: true });
  });
});
