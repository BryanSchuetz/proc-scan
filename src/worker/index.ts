import type { ApiError } from "../api/types";
import { EventsQueryError, listBiddingEvents, parseEventsQuery } from "../db/events";
import {
  authorizeRequest,
  isAccessFailure,
  isDevelopmentPreviewRequest,
  isLoopbackRequest,
} from "./access";
import { ScanWorkflow } from "./workflow";

export interface AppEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  SCAN_WORKFLOW: Workflow;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
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

  if (url.pathname === "/api/events") {
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
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "method_not_allowed", "This application is read-only.");
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request), request);
  },
} satisfies ExportedHandler<AppEnv>;
