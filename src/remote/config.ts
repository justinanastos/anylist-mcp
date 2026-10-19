import { fileURLToPath } from "node:url";

export interface ServerConfig {
  /** Public origin, e.g. `https://anylist.anastos-home.net`. */
  publicUrl: URL;
  port: number;
  dataDir: string;
  /** Cloudflare Access team domain, e.g. `little-dream-3e80.cloudflareaccess.com`. */
  cfTeamDomain: string;
  /**
   * Application Audience (AUD) tag of the Access app guarding `/interaction/*`. Empty means every
   * sign-in fails.
   */
  cfAccessAud: string;
  /** The only Google account allowed to sign in. */
  allowedEmail: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    publicUrl: new URL(env.PUBLIC_URL ?? "https://anylist.anastos-home.net"),
    port: Number(env.PORT ?? 8441),
    dataDir: env.DATA_DIR ?? fileURLToPath(new URL("../../data", import.meta.url)),
    cfTeamDomain: env.CF_TEAM_DOMAIN ?? "little-dream-3e80.cloudflareaccess.com",
    cfAccessAud: env.CF_ACCESS_AUD ?? "",
    allowedEmail: "justin.anastos@gmail.com",
  };
}

/** The resource every access token is bound to. Tokens work only for `/mcp`. */
export function mcpResource(config: ServerConfig): string {
  return new URL("/mcp", config.publicUrl).href;
}
