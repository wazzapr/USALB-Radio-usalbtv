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
  const page = decodePageText(html);
  const candidates = new Set<string>();

  const add = (value: string | undefined) => {
    if (!value) return;
    candidates.add(
      value
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&")
        .replace(/[),;'"]+$/, ""),
    );
  };

  for (const match of page.matchAll(/https?:\/\/[^\s"'<>]+/gi)) add(match[0]);
  for (const match of page.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  for (const match of page.matchAll(/(?:url|stream|mount|audio|playlist)\s*[:=]\s*["']([^"']+)["']/gi)) add(match[1]);

  const providerPattern =
    /(?:listen2myradio|listen2myshow|radio12345|radiostream123)\.com/i;

  const rankedCandidates = [...candidates]
    .map((raw) => {
      try {
        return new URL(raw, RADIO_PAGE).toString();
      } catch {
        return null;
      }
    })
    .filter((url): url is string => Boolean(url))
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          providerPattern.test(parsed.hostname) &&
          !/radiostream321\.com$/i.test(parsed.hostname)
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      const score = (value: string) => {
        let points = 0;
        if (/\/live\.mp3(?:[?]|$)/i.test(value)) points += 100;
        if (/\.(?:mp3|aac|ogg)(?:[?]|$)/i.test(value)) points += 80;
        if (/typeportmount=/i.test(value)) points += 60;
        if (/\/intro\.mp3(?:[?]|$)/i.test(value)) points += 40;
        if (/listen2myradio|listen2myshow|radio12345|radiostream123/i.test(value)) points += 10;
        return points;
      };
      return score(b) - score(a);
    });

  return rankedCandidates[0] ?? null;
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
