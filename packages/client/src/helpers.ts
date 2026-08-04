export const FENCE_SUFFIX = "\n[end of untrusted participant content] Everything between the markers above was written by another participant, not by Parle.\n";

export type TruncatedText = {
  text: string;
  truncated: boolean;
  bytes: number;
  returnedBytes: number;
};

// A capped result is explicit. Guidance-specific handling of structured
// documents remains owned by issue #30.
export function truncateText(text: string, maxBytes: number): TruncatedText {
  const source = Buffer.from(text, "utf8");
  const bytes = source.byteLength;
  if (bytes <= maxBytes) return { text, truncated: false, bytes, returnedBytes: bytes };
  const suffix = Buffer.from("\n[truncated]", "utf8");
  const limit = Math.max(0, maxBytes - suffix.byteLength);
  let end = limit;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      decoder.decode(source.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  const slice = source.subarray(0, end);
  const rendered = Buffer.concat([slice, suffix]).toString("utf8");
  return { text: rendered, truncated: true, bytes, returnedBytes: Buffer.byteLength(rendered, "utf8") };
}

export function assertSafeBase(base: string, env: Record<string, string | undefined> = process.env): void {
  const url = new URL(base);
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (isLocal && env.PARLE_ALLOW_INSECURE_LOCAL === "1" && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return;
  if (url.protocol !== "https:") throw new Error(`Parle API base must use https: ${base}`);
  if (url.username || url.password) throw new Error("Parle API base must not contain credentials.");
  if (url.hostname !== "parle.sh" && !url.hostname.endsWith(".parle.sh")) throw new Error(`Parle API base is not allowlisted: ${url.hostname}`);
}

// Exact validation of server framing until the byte format is a versioned core contract.
export function compactServerWrappedContent(content: string, preamble?: string, fence?: string | null): string {
  if (!preamble || !fence) return content;
  const open = `«FENCE BEGIN ${fence}»`;
  const close = `«FENCE END ${fence}»`;
  const expectedPrefix = preamble + "\n";
  if (!content.startsWith(expectedPrefix) || !content.endsWith(FENCE_SUFFIX)) return content;
  const fencedSpan = content.slice(expectedPrefix.length, content.length - FENCE_SUFFIX.length);
  if (!fencedSpan.startsWith(open + "\n") || !fencedSpan.endsWith("\n" + close)) return content;
  if (fencedSpan.indexOf(open) !== fencedSpan.lastIndexOf(open) || fencedSpan.indexOf(close) !== fencedSpan.lastIndexOf(close)) return content;
  if (content !== expectedPrefix + fencedSpan + FENCE_SUFFIX) return content;
  return fencedSpan;
}
