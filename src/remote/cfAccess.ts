import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface CfAccessOptions {
  teamDomain: string;
  aud: string;
  allowedEmail: string;
  /** Test seam. Defaults to the team's published signing keys. */
  keys?: JWTVerifyGetKey;
}

export class AccessDenied extends Error {}

/**
 * Returns a checker for the `Cf-Access-Jwt-Assertion` header. It fails closed: a missing header, a
 * bad signature, the wrong issuer or audience, an expired token, or any other email throws
 * {@link AccessDenied}.
 */
export function cfAccessVerifier(
  options: CfAccessOptions,
): (assertion: string | undefined) => Promise<string> {
  const issuer = `https://${options.teamDomain}`;
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (assertion) => {
    if (!assertion || !options.aud) throw new AccessDenied("no Cloudflare Access assertion");
    let email: unknown;
    try {
      const { payload } = await jwtVerify(assertion, keys, {
        issuer,
        audience: options.aud,
        algorithms: ["RS256"],
        // A fresh assertion carries nbf. This Mac and Cloudflare can disagree by a few seconds.
        clockTolerance: 15,
      });
      email = payload.email;
    } catch {
      throw new AccessDenied("Cloudflare Access assertion failed verification");
    }
    if (typeof email !== "string" || email.toLowerCase() !== options.allowedEmail) {
      throw new AccessDenied("email not allowed");
    }
    return email;
  };
}
