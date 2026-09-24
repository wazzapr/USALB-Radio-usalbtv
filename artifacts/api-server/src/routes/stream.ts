import { Router } from "express";
import { Readable } from "node:stream";

const streamRouter = Router();

const RADIO_PAGE = "https://usalbradio.radiostream321.com/";
const FALLBACK_URL = "https://uk4freenew.listen2myradio.com/live.mp3?typeportmount=s1_9311_stream_687568716";
const PROVIDER_RETRIES = 8;
const PROVIDER_RETRY_DELAY_MS = 500;
const CACHE_TTL_MS = 60 * 1000;

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
    .replace(/&amp;/gi, "&")
    .replace(/\\\//g, "/");
}

function extractStreamUrl(html: string): string | null {
  const page = decodePageText(html);
  const candidates = [
    ...page.matchAll(/https?:\/\/[^\s"\'<>]+?\.mp3(?:\?[^\s"\'<>]*)?/gi),
    ...page.matchAll(/https?:\/\/[^\s"\'<>]+listen2myradio[^\s"\'<>]*/gi),
  ];

  for (const match of candidates) {
    const value = match[0].replace(/[),;]+$/, "");
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch {
      // Ignore malformed page fragments and keep looking.
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
  }, 8000);

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
  return response.ok
    && Boolean(response.body)
    && (
      contentType.startsWith("audio/")
      || contentType.includes("mpeg")
      || contentType.includes("mp3")
    );
};

async function fetchReadyProviderStream(): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < PROVIDER_RETRIES; attempt += 1) {
    try {
      // Always rediscover after the first failed attempt. Listen2MyRadio can
      // change the mount while the station is waking up.
      const url = await fetchStreamUrl(attempt > 0);
      const upstream = await fetchWithHeaderTimeout(url, {
        headers: providerHeaders(),
        redirect: "follow",
        cache: "no-store",
      }, 8000);

      if (isAudioResponse(upstream)) {
        // Keep the working URL for subsequent listeners, but never trust it
        // forever; the short TTL and retry path handle provider rotation.
        cachedUrl = url;
        cacheExpiry = Date.now() + CACHE_TTL_MS;
        return upstream;
      }

      await upstream.body?.cancel();
      clearProviderCache();
      lastError = new Error("Radio provider is still waking up");
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
    // Keep the old known mount only as a last-resort compatibility fallback.
    res.setHeader("Cache-Control", "no-store");
    res.json({ url: FALLBACK_URL, source: "fallback" });
  }
});

streamRouter.get("/stream", async (req, res) => {
  if (req.query.fresh === "1") clearProviderCache();

  try {
    const upstream = await fetchReadyProviderStream();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    // Do not forward Content-Length for a live stream. Let Node use chunked
    // streaming so a provider cannot make the browser think the live stream
    // has a finite end.
    res.flushHeaders();
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  } catch {
    // Last-resort compatibility path. The normal path always tries the
    // current URL discovered from RadioStream321 first.
    try {
      const fallback = await fetchWithHeaderTimeout(FALLBACK_URL, {
        headers: providerHeaders(),
        redirect: "follow",
        cache: "no-store",
      }, 12000);
      if (!isAudioResponse(fallback)) {
        await fallback.body?.cancel();
        throw new Error("Fallback provider did not return audio");
      }
      res.status(fallback.status);
      res.setHeader("Content-Type", fallback.headers.get("content-type") ?? "audio/mpeg");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.flushHeaders();
      Readable.fromWeb(fallback.body as import("node:stream/web").ReadableStream).pipe(res);
    } catch {
      if (!res.headersSent) res.status(502).end("Radio stream unavailable");
    }
  }
});

export default streamRouter;
