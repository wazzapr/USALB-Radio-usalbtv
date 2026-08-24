import { Router } from "express";

const streamRouter = Router();

const RADIO_PAGE = "https://usalbradio.radiostream321.com/";
const FALLBACK_URL = "https://uk4freenew.listen2myradio.com/live.mp3?typeportmount=s1_9311_stream_687568716";

let cachedUrl: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchStreamUrl(): Promise<string> {
  if (cachedUrl && Date.now() < cacheExpiry) {
    return cachedUrl;
  }

  const res = await fetch(RADIO_PAGE, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RadioBot/1.0)",
    },
    signal: AbortSignal.timeout(8000),
  });

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

streamRouter.get("/stream-url", async (req, res) => {
  if (req.query.fresh === "1") {
    cachedUrl = null;
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
// resolves the provider's rotating stream address.
streamRouter.get("/stream", async (req, res) => {
  if (req.query.fresh === "1") {
    cachedUrl = null;
    cacheExpiry = 0;
  }

  try {
    const url = await fetchStreamUrl();
    res.redirect(302, url);
  } catch {
    res.redirect(302, FALLBACK_URL);
  }
});

export default streamRouter;
