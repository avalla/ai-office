/**
 * Access rules for the loopback dashboard host.
 *
 * The dashboard is intentionally local and read-only. The daemon keeps its
 * owner-only Unix socket, while this host binds only loopback addresses and
 * validates the Host header to prevent DNS rebinding from turning it into a
 * same-origin proxy.
 *
 * Loopback and Host validation are not human authentication or a same-UID
 * security boundary: any local process that can reach this port may request the
 * read-only surface.
 */
export type AccessDecision =
  | { kind: "allow" }
  | { kind: "deny"; status: number; message: string };

export interface AccessRequest {
  method: string;
  pathname: string;
  hostHeader: string | null;
}

export interface AccessPolicy {
  /** Host values this process answers to, for example `127.0.0.1:4278`. */
  allowedHosts: ReadonlySet<string>;
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

  return { kind: "allow" };
}
