import { Router } from "express";
import { Readable, PassThrough } from "node:stream";

const streamRouter = Router();

const RADIO_PAGE = "https://usalbradio.radiostream321.com/";
const PROVIDER_RETRIES = 4;
const PROVIDER_RETRY_DELAY_MS = 750;
const CACHE_TTL_MS = 4 * 60 * 1000;

let cachedUrl: string | null = null;
let cachedSessionCookie: string | null = null;
let cacheExpiry = 0;

function clearProviderCache() {
  cachedUrl = null;
  cachedSessionCookie = null;
  cacheExpiry = 0;
}

function decodePageText(value: string) {
  return value
    .replace(/\\u0026/gi, "&")
    .replace(/\\x26/gi, "&")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"');
}

function extractStreamUrl(html: string): string | null {
  // This is the exact discovery method from the old working USALB player.
  // RadioStream321 exposes the live relay URL directly in its page source.
  const match =
    html.match(/https?:\/\/[^\s"<>]+\.mp3[^\s"<>]*/i)
    ?? html.match(/https?:\/\/[^\s"<>]+listen2myradio[^\s"<>]*/i);

  return match?.[0]?.replace(/&amp;/g, "&") ?? null;
}

async function fetchWithHeaderTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStreamUrl(forceFresh = false): Promise<string> {
  if (!forceFresh && cachedUrl && Date.now() < cacheExpiry) return cachedUrl;

  if (forceFresh) clearProviderCache();

  const res = await fetchWithHeaderTimeout(RADIO_PAGE, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; USALBRadioPlayer/1.0)",
      "Cache-Control": "no-cache",
    },
    cache: "no-store",
    redirect: "follow",
  }, 6000);

  if (!res.ok) throw new Error(`Radio page returned ${res.status}`);

  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cachedSessionCookie = setCookie.split(";")[0] ?? null;

  const html = await res.text();
  const url = extractStreamUrl(html);
  if (!url) throw new Error("Stream URL not found in RadioStream321 page");

  cachedUrl = url;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return url;
}

const providerHeaders = () => ({
  Accept: "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
  Referer: RADIO_PAGE,
  Origin: new URL(RADIO_PAGE).origin,
  "User-Agent": "Mozilla/5.0 (compatible; USALBRadioPlayer/1.0)",
  ...(cachedSessionCookie ? { Cookie: cachedSessionCookie } : {}),
});

async function openProviderStream(url: string): Promise<Response> {
  return fetchWithHeaderTimeout(url, {
    headers: providerHeaders(),
    redirect: "follow",
    cache: "no-store",
  }, 8000);
}

async function validateAudioResponse(response: Response): Promise<Response> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Provider did not return a stream");
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html") || contentType.includes("application/json")) {
    await response.body.cancel();
    throw new Error("Provider returned HTML/JSON instead of audio");
  }

  // Inspect the first bytes without consuming them from the stream that will
  // actually be sent to the listener. The previous implementation attempted
  // to rebuild the stream from a ReadableStream reader, which is not a valid
  // Node WebStream and could leave the proxy with no playable body.
  const [inspectionStream, playbackStream] = response.body.tee();
  const reader = inspectionStream.getReader();

  try {
    const first = await reader.read();

    if (first.done || !first.value?.byteLength) {
      throw new Error("Provider returned an empty stream");
    }

    const prefix = Buffer.from(first.value);
    const sample = prefix.toString("utf8").trim().slice(0, 512).toLowerCase();

    const looksLikeHtml =
      sample.startsWith("<!doctype")
      || sample.startsWith("<html")
      || sample.startsWith("<head")
      || sample.startsWith("<body")
      || sample.includes("<html")
      || sample.includes("<!doctype");

    if (looksLikeHtml || prefix.length <= 1) {
      throw new Error("Provider returned an invalid placeholder");
    }

    const looksLikeAudio =
      contentType === ""
      || contentType.startsWith("audio/")
      || contentType.includes("mpeg")
      || contentType.includes("mp3")
      || contentType.includes("octet-stream")
      || contentType.includes("ogg")
      || contentType.includes("aac")
      || contentType.startsWith("text/plain");

    if (!looksLikeAudio) {
      throw new Error(\`Unsupported provider content type: \${contentType}\`);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return new Response(playbackStream, {
    status: response.status,
    headers: response.headers,
  });
}

async function fetchReadyProviderStream(): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < PROVIDER_RETRIES; attempt += 1) {
    try {
      const url = await fetchStreamUrl(true);
      const upstream = await openProviderStream(url);
      const validated = await validateAudioResponse(upstream);
      cachedUrl = url;
      cacheExpiry = Date.now() + CACHE_TTL_MS;
      return validated;
    } catch (error) {
      clearProviderCache();
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, PROVIDER_RETRY_DELAY_MS));
  }

  throw lastError instanceof Error ? lastError : new Error("Radio stream unavailable");
}

streamRouter.get("/stream-url", async (req, res) => {
  const forceFresh = req.query.fresh === "1";

  try {
    const url = await fetchStreamUrl(forceFresh);
    res.setHeader("Cache-Control", "no-store");
    res.json({ url, source: "live" });
  } catch {
    res.status(503);
    res.setHeader("Cache-Control", "no-store");
    res.json({ error: "Live stream URL unavailable", source: "radiostream321" });
  }
});

streamRouter.get("/stream", async (req, res) => {
  if (req.query.fresh === "1") clearProviderCache();

  try {
    const upstream = await fetchReadyProviderStream();
    res.status(upstream.status);

    const upstreamContentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
    res.setHeader(
      "Content-Type",
      upstreamContentType.startsWith("text/plain") || !upstreamContentType
        ? "audio/mpeg"
        : upstreamContentType,
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Accept-Ranges", "none");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  } catch {
    clearProviderCache();
    if (!res.headersSent) res.status(502).end("Radio stream unavailable");
  }
});

export default streamRouter;
