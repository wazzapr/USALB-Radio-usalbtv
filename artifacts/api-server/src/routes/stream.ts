import { Router } from "express";
import { Readable } from "node:stream";

const streamRouter = Router();

const RADIO_PAGE = "https://usalbradio.radiostream321.com/";
const FALLBACK_URL = "https://uk4freenew.listen2myradio.com/live.mp3?typeportmount=s1_9311_stream_687568716";
const PROVIDER_RETRIES = 8;
const PROVIDER_RETRY_DELAY_MS = 500;

let cachedUrl: string | null = null;
let cachedSessionCookie: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchStreamUrl(forceFresh = false): Promise<string> {
  if (!forceFresh && cachedUrl && Date.now() < cacheExpiry) {
    return cachedUrl;
  }

  const res = await fetch(RADIO_PAGE, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; USALBRadioPlayer/1.0)",
    },
    signal: AbortSignal.timeout(8000),
  });

  const setCookie = res.headers.get("set-cookie");
  cachedSessionCookie = setCookie?.split(";")[0] ?? null;
  const html = await res.text();

  // The stream URL appears in the page source as plain text inside a hidden div
  const match = html.match(/https?:\/\/[^\s"<>]+\.mp3[^\s"<>]*/i)
    ?? html.match(/https?:\/\/[^\s"<>]+listen2myradio[^\s"<>]*/i);

  if (match) {
    cachedUrl = match[0];
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return cachedUrl;
  }

  throw new Error("Stream URL not found in page source");
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
  const contentLength = response.headers.get("content-length");
  return response.ok
    && Boolean(response.body)
    && (contentType.startsWith("audio/") || (!contentType && contentLength !== "1"));
};

async function fetchReadyProviderStream(): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < PROVIDER_RETRIES; attempt += 1) {
    try {
      // Refresh the page/session on every attempt. Listen2MyRadio can rotate
      // the mount while it is waking up, and an old mount returns only "\n".
      const url = await fetchStreamUrl(attempt > 0);
      const upstream = await fetch(url, {
        headers: providerHeaders(),
        signal: AbortSignal.timeout(5000),
      });

      if (isAudioResponse(upstream)) {
        return upstream;
      }

      await upstream.body?.cancel();
      lastError = new Error("Radio provider is still waking up");
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, PROVIDER_RETRY_DELAY_MS));
  }

  throw lastError instanceof Error ? lastError : new Error("Radio stream unavailable");
}

streamRouter.get("/stream-url", async (req, res) => {
  if (req.query.fresh === "1") {
    cachedUrl = null;
    cachedSessionCookie = null;
    cacheExpiry = 0;
  }
  try {
    const url = await fetchStreamUrl();
    res.json({ url, source: "live" });
  } catch (err) {
    res.json({ url: FALLBACK_URL, source: "fallback" });
  }
});

// Keep the browser's first play() call tied to the user's click. The client
// can start loading this same-origin endpoint immediately while the server
// resolves and proxies the provider's rotating stream address.
streamRouter.get("/stream", async (req, res) => {
  if (req.query.fresh === "1") {
    cachedUrl = null;
    cacheExpiry = 0;
  }

  try {
    const upstream = await fetchReadyProviderStream();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  } catch {
    // A second provider request with the known backup address gives the
    // browser a real audio response even when the station page rotates its
    // stream address during startup.
    try {
      const fallback = await fetch(FALLBACK_URL, {
        headers: providerHeaders(),
        signal: AbortSignal.timeout(12000),
      });
      if (!isAudioResponse(fallback)) {
        await fallback.body?.cancel();
        throw new Error("Fallback provider did not return audio");
      }
      res.status(fallback.status);
      res.setHeader("Content-Type", fallback.headers.get("content-type") ?? "audio/mpeg");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      Readable.fromWeb(fallback.body as import("node:stream/web").ReadableStream).pipe(res);
    } catch {
      if (!res.headersSent) res.status(502).end("Radio stream unavailable");
    }
  }
});

export default streamRouter;
