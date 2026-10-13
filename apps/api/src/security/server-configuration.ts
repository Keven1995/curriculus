import { timingSafeEqual } from "node:crypto";

export function resolveCorsOrigin(configuredOrigin: string | undefined, production: boolean): string | null {
  const candidate = configuredOrigin?.trim();
  if (!candidate) return production ? null : "http://localhost:3000";
  if (candidate === "*") return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const isExactOrigin = candidate === url.origin || candidate === `${url.origin}/`;
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    !isExactOrigin ||
    (production && url.protocol !== "https:")
  ) {
    return null;
  }
  return url.origin;
}

export function parseTrustedProxyHops(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 && hops <= 5 ? hops : 0;
}

export function isStrongSecret(value: string | undefined): value is string {
  return Boolean(value && value.trim() === value && !/\s/.test(value) && Buffer.byteLength(value, "utf8") >= 32);
}

export function matchesBearerSecret(secret: string | undefined, authorization: string | undefined): boolean {
  if (!isStrongSecret(secret) || !authorization) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;
  const expected = Buffer.from(secret, "utf8");
  const received = Buffer.from(match[1]!, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
