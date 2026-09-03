/**
 * Access rules for the loopback dashboard host.
 *
 * What these rules genuinely provide, and nothing more:
 *
 * - the daemon itself keeps its owner-only Unix socket; opening a TCP port is
 *   this process's decision, made explicitly by the user, and it dies with the
 *   process;
 * - a loopback TCP port is reachable by *every* local Unix account, unlike a
 *   0600 socket. The per-process session token restores that separation: it is
 *   printed to the starting terminal and never written to disk, so another
 *   local user cannot read project state through this port;
 * - a `Host` allowlist blocks DNS rebinding, where a page the user visits
 *   resolves an attacker-controlled name to 127.0.0.1 and then reads responses
 *   as same-origin.
 *
 * What they do NOT provide, and must never be described as providing:
 *
 * - authentication of a human. Nobody proves who they are here.
 * - separation between same-UID processes. Any process running as this user can
 *   read the terminal, the process environment, or simply talk to the daemon
 *   socket directly. That limit is the same one recorded in the existing trust
 *   model, and this surface does not change it.
 */

export const sessionCookieName = "ai_office_dashboard";
export const sessionTokenParameter = "token";

export type AccessDecision =
  | { kind: "allow" }
  | { kind: "adopt_token" }
  | { kind: "deny"; status: number; message: string };

export interface AccessRequest {
  method: string;
  pathname: string;
  hostHeader: string | null;
  cookieHeader: string | null;
  queryToken: string | null;
}

export interface AccessPolicy {
  token: string;
  /** Host values this process answers to, for example `127.0.0.1:4278`. */
  allowedHosts: ReadonlySet<string>;
}

/** Constant-time-ish comparison; both values are process-local secrets. */
function tokensMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function readSessionCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== sessionCookieName) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export function decideAccess(
  request: AccessRequest,
  policy: AccessPolicy,
): AccessDecision {
  if (request.method !== "GET")
    return {
      kind: "deny",
      status: 405,
      message: "The dashboard is read-only and only accepts GET",
    };

  // Rejecting an unexpected Host is what stops a rebound DNS name from being
  // treated as this origin by the browser.
  if (
    request.hostHeader === null ||
    !policy.allowedHosts.has(request.hostHeader)
  )
    return {
      kind: "deny",
      status: 400,
      message: "Unexpected Host header",
    };

  const cookie = readSessionCookie(request.cookieHeader);
  if (cookie !== null && tokensMatch(cookie, policy.token))
    return { kind: "allow" };

  if (
    request.queryToken !== null &&
    tokensMatch(request.queryToken, policy.token)
  )
    return { kind: "adopt_token" };

  return {
    kind: "deny",
    status: 403,
    message:
      "This dashboard session requires the token printed by ai-office dashboard",
  };
}

export function sessionCookieValue(token: string): string {
  // Host-only, path-wide, not readable from script, and not sent on
  // cross-site navigations.
  return `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}
