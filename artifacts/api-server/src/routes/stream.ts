import { Router } from "express";

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

// Relay the live stream through our origin. The browser keeps one stable
// /api/stream URL while this handler refreshes the provider URL whenever an
// upstream connection ends. That hides rotating provider URLs from listeners.
streamRouter.get("/stream", async (req, res) => {
  let clientDisconnected = false;
  let headersSent = false;
  let upstreamAbort: AbortController | null = null;

  res.on("close", () => {
    clientDisconnected = true;
    upstreamAbort?.abort();
  });

  try {
    while (!clientDisconnected && !res.destroyed) {
      let target: { url: string; cookie?: string };

      try {
        // Resolve the station page again on every upstream connection. The
        // provider may rotate its published MP3 URL or session token.
        target = await fetchStreamTarget();
      } catch (err) {
        req.log.warn({ err }, "Unable to resolve radio stream; will retry");
        if (!headersSent) {
          await wait(1000);
          if (!clientDisconnected) continue;
          return;
        }
        await wait(1500);
        continue;
      }

      let upstream: Response | null = null;
      for (let attempt = 0; attempt < 4 && !clientDisconnected; attempt += 1) {
        upstreamAbort = new AbortController();
        try {
          const candidate = await fetch(target.url, {
            headers: {
              "User-Agent": BROWSER_USER_AGENT,
              "Referer": RADIO_PAGE,
              "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.5",
              ...(target.cookie ? { Cookie: target.cookie } : {}),
            },
            redirect: "follow",
            signal: upstreamAbort.signal,
          });
          const contentType = candidate.headers.get("content-type") ?? "";
          if (candidate.ok && candidate.body && contentType.toLowerCase().startsWith("audio/")) {
            upstream = candidate;
            break;
          }
          await candidate.arrayBuffer();
        } catch (err) {
          if (clientDisconnected) return;
          req.log.warn({ err }, "Radio upstream connection failed");
        }
        if (attempt < 3 && !clientDisconnected) await wait(1000);
      }

      if (!upstream?.body) {
        if (!headersSent) {
          res.status(502).json({ error: "Radio stream is unavailable" });
          return;
        }
        await wait(1500);
        continue;
      }

      if (!headersSent) {
        res.status(200);
        res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Accept-Ranges", "none");
        headersSent = true;
      }

      // Keep the client response open across upstream disconnects. If the
      // provider ends or rotates its stream, resolve a fresh URL and continue.
      const reader = upstream.body.getReader();
      try {
        while (!clientDisconnected && !res.destroyed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            const canContinue = res.write(Buffer.from(value));
            if (!canContinue) {
              await new Promise<void>((resolve) => res.once("drain", resolve));
            }
          }
        }
      } catch (err) {
        if (!clientDisconnected) req.log.warn({ err }, "Radio upstream stream ended unexpectedly");
      } finally {
        try { await reader.cancel(); } catch { /* upstream may already be closed */ }
        upstreamAbort?.abort();
        upstreamAbort = null;
      }

      if (!clientDisconnected && !res.destroyed) await wait(1000);
    }
  } catch (err) {
    req.log.warn({ err }, "Unable to relay radio stream");
    if (!res.headersSent) res.status(502).json({ error: "Radio stream is unavailable" });
    else if (!res.destroyed) res.end();
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
