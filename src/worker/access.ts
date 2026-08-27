import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";

export interface AccessEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}

export type AccessVerifier = (
  token: string,
  env: Required<AccessEnv>,
) => Promise<JWTPayload>;

const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizedTeamDomain(value: string): string {
  return value.replace(/\/+$/, "");
}

async function verifyAccessJwt(token: string, env: Required<AccessEnv>): Promise<JWTPayload> {
  const teamDomain = normalizedTeamDomain(env.TEAM_DOMAIN);
  let jwks = jwksByDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByDomain.set(teamDomain, jwks);
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: teamDomain,
    audience: env.POLICY_AUD,
  });
  return payload;
}

export function isLoopbackRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function isDevelopmentPreviewRequest(request: Request): boolean {
  return import.meta.env.DEV && new URL(request.url).hostname.endsWith(".onamp.dev");
}

export interface AuthorizedUser {
  email?: string;
  subject?: string;
}

export interface AccessFailure {
  status: 403 | 503;
  code: "access_not_configured" | "access_token_missing" | "access_token_invalid";
  message: string;
}

export async function authorizeRequest(
  request: Request,
  env: AccessEnv,
  verifier: AccessVerifier = verifyAccessJwt,
): Promise<AuthorizedUser | AccessFailure> {
  if (isLoopbackRequest(request) || isDevelopmentPreviewRequest(request)) return {};

  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
    return {
      status: 503,
      code: "access_not_configured",
      message: "Cloudflare Access is not configured for this environment.",
    };
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return {
      status: 403,
      code: "access_token_missing",
      message: "A Cloudflare Access token is required.",
    };
  }

  try {
    const payload = await verifier(token, {
      TEAM_DOMAIN: env.TEAM_DOMAIN,
      POLICY_AUD: env.POLICY_AUD,
    });
    return {
      email: typeof payload.email === "string" ? payload.email : undefined,
      subject: payload.sub,
    };
  } catch {
    return {
      status: 403,
      code: "access_token_invalid",
      message: "The Cloudflare Access token is invalid.",
    };
  }
}

export function isAccessFailure(result: AuthorizedUser | AccessFailure): result is AccessFailure {
  return "status" in result;
}
