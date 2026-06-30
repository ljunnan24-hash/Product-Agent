import type { AgentToolGuardrailResult } from "./types";

export type PublicUrlSecurityResult = {
  url: string;
  normalizedUrl?: string;
  safe: boolean;
  reason: string;
  risk: "none" | "invalid" | "protocol" | "credential" | "localhost" | "private_ip" | "internal_host";
};

const internalHostnames = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
  "169.254.169.254"
]);

const sensitiveKeyPattern = /(api[_-]?key|apikey|authorization|bearer|token|secret|password|passwd|credential|private[_-]?key|session|cookie)/i;

export function assessPublicUrlSafety(url: string): PublicUrlSecurityResult {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return blocked(url, "protocol", `Only http/https URLs are allowed (${parsed.protocol || "unknown"}).`);
    }
    if (parsed.username || parsed.password) {
      return blocked(url, "credential", "URL credentials are not allowed.");
    }
    if (
      internalHostnames.has(hostname) ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".localhost")
    ) {
      return blocked(url, "internal_host", `${hostname} is treated as internal metadata/local host.`);
    }
    if (isBlockedIpLiteral(hostname)) {
      return blocked(url, "private_ip", `${hostname} is not a public routable IP.`);
    }
    return {
      url,
      normalizedUrl: parsed.toString(),
      safe: true,
      reason: "Public http/https URL.",
      risk: "none"
    };
  } catch {
    return blocked(url, "invalid", "URL parsing failed.");
  }
}

export function isSafePublicUrl(url: string) {
  return assessPublicUrlSafety(url).safe;
}

export function filterSafePublicUrls(urls: string[]) {
  return urls.filter(isSafePublicUrl);
}

export function publicUrlGuardrails(urls: string[], maxUrls: number): AgentToolGuardrailResult[] {
  const assessments = urls.map(assessPublicUrlSafety);
  const safeUrls = assessments.filter((item) => item.safe);
  const blockedUrls = assessments.filter((item) => !item.safe);
  const blockedReasonSummary = blockedUrls
    .slice(0, 4)
    .map((item) => `${item.risk}:${item.reason}`)
    .join(" | ");
  return [
    guard("fetch-url-count", "URL cap", urls.length <= maxUrls ? "pass" : "warn", `${urls.length}/${maxUrls} URLs accepted for this batch.`),
    guard(
      "fetch-public-url",
      "Public URL",
      safeUrls.length === urls.length ? "pass" : "block",
      `${safeUrls.length}/${urls.length} URLs passed public URL safety checks.${blockedReasonSummary ? ` Blocked: ${blockedReasonSummary}` : ""}`
    ),
    guard(
      "fetch-ssrf-boundary",
      "SSRF boundary",
      blockedUrls.some((item) => item.risk === "private_ip" || item.risk === "localhost" || item.risk === "internal_host")
        ? "block"
        : "pass",
      blockedUrls.some((item) => item.risk === "private_ip" || item.risk === "localhost" || item.risk === "internal_host")
        ? "Blocked localhost/private/internal URL target."
        : "No localhost/private/internal targets detected."
    ),
    guard("fetch-nonempty", "Non-empty input", urls.length ? "pass" : "warn", urls.length ? "Fetch batch has URLs." : "No URLs to fetch.")
  ];
}

export function promptInjectionSignals(text: string) {
  const patterns = [
    /ignore (all )?(previous|prior) instructions/i,
    /disregard (all )?(previous|prior) instructions/i,
    /system prompt/i,
    /developer message/i,
    /you are now/i,
    /do not obey/i,
    /reveal (the )?(system|developer) prompt/i,
    /请忽略(以上|之前|前面).*指令/i,
    /不要遵守(以上|之前|前面).*要求/i,
    /系统提示词/i,
    /开发者消息/i
  ];
  return patterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
}

export function untrustedContentGuardrail({
  text,
  label
}: {
  text: string;
  label: string;
}): AgentToolGuardrailResult {
  const signals = promptInjectionSignals(text);
  return guard(
    "untrusted-prompt-injection",
    "Prompt injection",
    signals.length ? "warn" : "pass",
    signals.length
      ? `${label} contains instruction-like content: ${signals.slice(0, 3).join(" | ")}`
      : `${label} has no obvious instruction-injection pattern.`
  );
}

export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 12) return "[redacted:max-depth]" as T;
  if (typeof value === "string") return redactSecretsInText(value) as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (sensitiveKeyPattern.test(key)) return [key, "[redacted:secret-key]"];
      return [key, redactSecrets(item, depth + 1)];
    });
    return Object.fromEntries(entries) as T;
  }
  return value;
}

export function redactSecretsInText(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[redacted]")
    .replace(/\b[A-Fa-f0-9]{24,}\.[A-Za-z0-9_-]{12,}\b/g, "[redacted:provider-key]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]")
    .replace(/\b(Authorization\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

function isBlockedIpLiteral(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80")) {
    return true;
  }
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map((item) => Number(item));
  if ([a, b].some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function blocked(
  url: string,
  risk: PublicUrlSecurityResult["risk"],
  reason: string
): PublicUrlSecurityResult {
  return {
    url,
    safe: false,
    reason,
    risk
  };
}

function guard(
  id: string,
  label: string,
  status: AgentToolGuardrailResult["status"],
  message: string
): AgentToolGuardrailResult {
  return { id, label, status, message };
}
