import { Router } from "express";
import { Readable } from "node:stream";
import {
  fetchStreamTarget,
  openFreshRadioAudio,
  wakeRadioStation,
} from "../lib/radio-provider";
import {
  ensureRadioHlsRunning,
  getRadioHlsFilePath,
  waitForRadioHlsPlaylist,
} from "../lib/radio-hls";

const streamRouter = Router();

// HLS gives each listener short playlist/segment requests instead of one live
// HTTP request that the hosting proxy terminates after five minutes.
streamRouter.get("/radio-hls/:filename", async (req, res): Promise<void> => {
  const rawFilename = req.params.filename;
  const filename = Array.isArray(rawFilename) ? rawFilename[0] : rawFilename;
  const filePath = getRadioHlsFilePath(filename);
  if (!filePath) {
    res.status(404).end();
    return;
  }

  ensureRadioHlsRunning();
  if (filename === "playlist.m3u8" && !(await waitForRadioHlsPlaylist())) {
    res.setHeader("Retry-After", "2");
    res.status(503).json({ error: "Live radio is starting" });
    return;
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.type(filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
});

// Legacy continuous MP3 endpoint retained for compatibility and diagnostics.
streamRouter.get("/stream", async (req, res) => {
  let audioConnection: Awaited<ReturnType<typeof openFreshRadioAudio>> | null = null;
  try {
    audioConnection = await openFreshRadioAudio();
  } catch (err) {
    req.log.warn({ err }, "Radio stream is not returning audio");
    res.status(502).json({ error: "Radio stream is unavailable" });
    return;
  }

  const controller = audioConnection.controller;
  const clientDisconnected = () => controller.abort();
  req.once("aborted", clientDisconnected);
  res.once("close", () => {
    if (!res.writableEnded) clientDisconnected();
  });

  res.status(200);
  res.setHeader("Content-Type", audioConnection.response.headers.get("content-type") ?? "audio/mpeg");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Accept-Ranges", "none");
  if (audioConnection.response.body) {
    Readable.fromWeb(audioConnection.response.body as ReadableStream<Uint8Array>).pipe(res);
  }
});

streamRouter.get("/stream-warmup", async (req, res) => {
  try {
    ensureRadioHlsRunning();
    if (!(await waitForRadioHlsPlaylist())) {
      throw new Error("Timed out waiting for the live radio segments");
    }
    res.json({ ready: true });
  } catch (err) {
    req.log.warn({ err }, "Unable to warm the radio station");
    res.status(503).json({ ready: false, error: "Radio station is not ready" });
  }
});

streamRouter.get("/stream-url", async (req, res) => {
  try {
    const target = await fetchStreamTarget();
    await wakeRadioStation(target.cookie);
    res.json({ url: target.url, source: "live" });
  } catch (err) {
    req.log.warn({ err }, "Unable to resolve the live radio URL");
    res.status(503).json({ error: "Radio stream is unavailable" });
  }
});

export default streamRouter;
