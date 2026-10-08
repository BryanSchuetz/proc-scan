import type { ApiError } from "../api/types";
import { EventsQueryError, listBiddingEvents, parseEventsQuery } from "../db/events";
import {
  authorizeRequest,
  isAccessFailure,
  isAdminRequest,
  isDevelopmentPreviewRequest,
  isLoopbackRequest,
} from "./access";
import { ScanWorkflow } from "./workflow";
import { handleUploads } from "./uploads";

export interface AppEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  BROWSER: Fetcher;
  SCAN_WORKFLOW: Workflow;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  ADMIN_EMAILS?: string;
  SAM_API_KEY?: string;
  CAMP_MONTR_KEY?: string;
  CAMP_MONTR_CLIENT_ID?: string;
  DIGEST_FROM?: string;
  DIGEST_REPLY_TO?: string;
  DIGEST_RECIPIENT?: string;
  REGISTRY_URL?: string;
}

export { ScanWorkflow };

const securityHeaders = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  return Response.json(body, { ...init, headers });
}

function errorResponse(status: number, code: string, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return jsonResponse(body, { status });
}

function withSecurityHeaders(response: Response, request: Request): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders)) secured.headers.set(name, value);
  if (isLoopbackRequest(request) || isDevelopmentPreviewRequest(request)) {
    secured.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws: wss:",
    );
  }
  return secured;
}

async function handleApi(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "The API is read-only.");
  }

  if (url.pathname === "/api/opportunities" || url.pathname === "/api/events") {
    try {
      const response = await listBiddingEvents(env.DB, parseEventsQuery(url));
      return jsonResponse(response);
    } catch (error) {
      if (error instanceof EventsQueryError) {
        return errorResponse(400, "invalid_query", error.message);
      }
      console.error("Unable to list bidding events", error instanceof Error ? error.message : "unknown error");
      return errorResponse(500, "events_unavailable", "Bidding Events could not be loaded.");
    }
  }

  if (url.pathname === "/api/health") {
    return jsonResponse({ status: "ok" });
  }

  return errorResponse(404, "not_found", "API route not found.");
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const access = await authorizeRequest(request, env);
    if (isAccessFailure(access)) {
      return errorResponse(access.status, access.code, access.message);
    }

    const url = new URL(request.url);
    const isAdmin = isAdminRequest(request, access, env);
    if (url.pathname === "/api/session" && request.method === "GET") {
      return jsonResponse({ isAdmin });
    }
    if (["/admin", "/upload"].includes(url.pathname.replace(/\/+$/, ""))
      || url.pathname.startsWith("/api/admin/")
      || url.pathname === "/api/uploads" || url.pathname.startsWith("/api/uploads/")) {
      if (!isAdmin) return errorResponse(403, "admin_required", "Administrator access is required.");
    }
    if (url.pathname.startsWith("/api/admin/")) {
      const match = /^\/api\/admin\/opportunities\/([^/]+)\/status$/.exec(url.pathname);
      if (!match) return errorResponse(404, "not_found", "Admin route not found.");
      if (request.method !== "PATCH") return errorResponse(405, "method_not_allowed", "Use PATCH to change marking status.");
      if (request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
        return errorResponse(403, "invalid_origin", "Change marking status from the registry page.");
      }
      if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
        return errorResponse(400, "invalid_status", "Send a JSON marking status.");
      }
      const body = await request.json().catch(() => null) as { status?: unknown } | null;
      if (body?.status !== "addressable" && body?.status !== "uncertain") {
        return errorResponse(400, "invalid_status", "Choose Marked or Unmarked.");
      }
      try {
        const result = await env.DB.prepare(`UPDATE bidding_events
          SET manual_addressability_status = ?, manually_marked_by = ?, manually_marked_at = ?
          WHERE id = ? AND (due_date IS NULL OR due_date > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            AND (EXISTS (SELECT 1 FROM sources WHERE id = bidding_events.source_id AND enabled = 1)
              OR json_extract(source_data_json, '$.upload.id') IS NOT NULL)`)
          .bind(body.status, access.email ?? access.subject ?? "local-preview", new Date().toISOString(), decodeURIComponent(match[1]))
          .run();
        if (!result.meta.changes) return errorResponse(404, "not_found", "This Bidding Event is no longer available in the registry.");
        return jsonResponse({ status: body.status });
      } catch {
        return errorResponse(500, "status_unavailable", "Marking status could not be saved. Please try again.");
      }
    }
    if (url.pathname === "/api/uploads" || url.pathname.startsWith("/api/uploads/")) {
      try {
        const response = withSecurityHeaders(await handleUploads(request, env.DB, access), request);
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch {
        return errorResponse(500, "uploads_unavailable", "Uploads could not be loaded or saved. Please try again.");
      }
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "method_not_allowed", "This application is read-only.");
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request), request);
  },
} satisfies ExportedHandler<AppEnv>;
