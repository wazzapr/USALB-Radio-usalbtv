import { Router } from "express";
import { Readable } from "node:stream";

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

  // RadioStream321 renders the current Listen2MyRadio mount inside the
  // station page. Do not depend on one exact URL shape: the mount can rotate
  // and the provider may expose it in href/src attributes or JavaScript.
  const candidates = new Set<string>();
  const addCandidates = (pattern: RegExp) => {
    for (const match of page.matchAll(pattern)) {
      const raw = match[1] ?? match[0];
      if (raw) candidates.add(raw.replace(/\\\//g, "/"));
    }
  };

  addCandidates(/https?:\/\/[^\s"'<>]+/gi);
  addCandidates(/(?:src|href)\s*=\s*["']([^"']+)["']/gi);

  const providerPattern =
    /(?:listen2myradio|listen2myshow|radio12345|radiostream123)\\.com/i;

  // Prefer the actual live audio mount over generic provider/profile links.
  // RadioStream321 pages commonly expose the mount as /live.mp3?typeportmount=... .
  const rankedCandidates = [...candidates].sort((a, b) => {
    const score = (value: string) => {
      let points = 0;
      if (/\\/live\\.mp3(?:[?]|$)/i.test(value)) points += 100;
      if (/\\.(?:mp3|aac|ogg)(?:[?]|$)/i.test(value)) points += 80;
      if (/typeportmount=/i.test(value)) points += 60;
      if (/\\/intro\\.mp3(?:[?]|$)/i.test(value)) points += 40;
      if (/listen2myradio|listen2myshow|radio12345|radiostream123/i.test(value)) points += 10;
      return points;
    };
    return score(b) - score(a);
  });

  for (const raw of rankedCandidates) {
    const value = raw
      .replace(/&amp;/gi, "&")
      .replace(/[),;'\"]+$/, "");

    try {
      const url = new URL(value, RADIO_PAGE);
      if (
        (url.protocol === "http:" || url.protocol === "https:")
        && providerPattern.test(url.hostname)
        && !/radiostream321\\.com$/i.test(url.hostname)
      ) {
        return url.toString();
      }
    } catch {
      // Ignore unrelated/malformed page URLs.
    }
  }

  return null;
}

async function fetchWithHeaderTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    // fetch() resolves when response headers arrive. The live audio body must
    // NOT inherit the connection timeout or it would be killed while playing.
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStreamUrl(forceFresh = false): Promise<string> {
  if (!forceFresh && cachedUrl && Date.now() < cacheExpiry) {
    return cachedUrl;
  }

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

const isAudioResponse = (response: Response) => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  // Some Listen2MyRadio mounts identify live MP3 as application/octet-stream
  // or omit a useful content type. Reject obvious HTML/text responses, but
  // allow the provider's binary live-audio responses.
  const looksLikeHtml = contentType.includes("text/html") || contentType.includes("application/json");
  const looksLikeAudio =
    contentType === ""
    || contentType.startsWith("audio/")
    || contentType.includes("mpeg")
    || contentType.includes("mp3")
    || contentType.includes("octet-stream")
    || contentType.includes("ogg")
    || contentType.includes("aac")
    || contentType.startsWith("text/plain");

  return response.ok && Boolean(response.body) && !looksLikeHtml && looksLikeAudio;
};

async function fetchReadyProviderStream(): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < PROVIDER_RETRIES; attempt += 1) {
    try {
      // Rediscover after a failed known mount. Listen2MyRadio can rotate the
      // mount while the station is waking up.
      const url = await fetchStreamUrl(true);
      const upstream = await fetchWithHeaderTimeout(url, {
        headers: providerHeaders(),
        redirect: "follow",
        cache: "no-store",
      }, 8000);

      if (isAudioResponse(upstream)) {
        cachedUrl = url;
        cacheExpiry = Date.now() + CACHE_TTL_MS;
        return upstream;
      }

      await upstream.body?.cancel();
      clearProviderCache();
      lastError = new Error("Radio provider returned a non-audio response");
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
    // Do not forward Content-Length for a live stream. Let Node use chunked
    // streaming so a provider cannot make the browser think the live stream
    // has a finite end.
    res.flushHeaders();
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  } catch {
    clearProviderCache();
    if (!res.headersSent) res.status(502).end("Radio stream unavailable");
  }
});

export default streamRouter;
