import { Router } from "express";
import { Readable } from "node:stream";

const streamRouter = Router();

const RADIO_PAGE = "https://usalbradio.radiostream321.com/";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchStreamTarget(): Promise<{ url: string; cookie?: string }> {
  const res = await fetch(RADIO_PAGE, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Radio page returned ${res.status}`);
  const html = await res.text();

  // The stream URL appears in the page source as plain text inside a hidden div
  const match = html.match(/https?:\/\/[^\s"<>]+\.mp3[^\s"<>]*/i)
    ?? html.match(/https?:\/\/[^\s"<>]+listen2myradio[^\s"<>]*/i);

  if (match) {
    return {
      url: match[0].replace(/&amp;/g, "&"),
      cookie: res.headers.get("set-cookie")?.split(";")[0],
    };
  }

  throw new Error("Stream URL not found in page source");
}

// Relay the live stream through our origin. This avoids browser CORS/referrer
// differences and lets the provider see the same page context as its player.
streamRouter.get("/stream", async (req, res) => {
  try {
    const target = await fetchStreamTarget();
    let upstream: Response | null = null;

    // The provider can return a one-byte HTML response while its relay wakes
    // up. Give it a few seconds before reporting the station as unavailable.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = await fetch(target.url, {
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          "Referer": RADIO_PAGE,
          "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.5",
          ...(target.cookie ? { Cookie: target.cookie } : {}),
        },
        redirect: "follow",
      });
      const contentType = candidate.headers.get("content-type") ?? "";
      if (candidate.ok && candidate.body && contentType.toLowerCase().startsWith("audio/")) {
        upstream = candidate;
        break;
      }
      await candidate.arrayBuffer();
      if (attempt < 3) await wait(1000);
    }

    if (!upstream?.body) {
      res.status(502).json({ error: "Radio stream is unavailable" });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Accept-Ranges", "none");
    Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>).pipe(res);
  } catch (err) {
    req.log.warn({ err }, "Unable to relay radio stream");
    if (!res.headersSent) res.status(502).json({ error: "Radio stream is unavailable" });
  }
});

streamRouter.get("/stream-url", async (req, res) => {
  try {
    // Return the exact freshly published URL for the user's audio element.
    // The client must not alter the provider's rotating token or append query
    // parameters that turn the response into a non-audio document.
    const target = await fetchStreamTarget();
    res.json({ url: target.url, source: "live" });
  } catch (err) {
    res.status(503).json({ error: "Radio stream is unavailable" });
  }
});

export default streamRouter;
