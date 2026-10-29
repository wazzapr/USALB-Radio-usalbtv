import { spawn } from "node:child_process";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger";
import { openFreshRadioAudio } from "./radio-provider";

const HLS_DIRECTORY = join(tmpdir(), "usalb-radio-live");
const PLAYLIST_PATH = join(HLS_DIRECTORY, "playlist.m3u8");
const SEGMENT_PATTERN = join(HLS_DIRECTORY, "segment-%06d.ts");
const INPUT_IDLE_TIMEOUT_MS = 25000;
const SEGMENT_PATTERN_REGEX = /^segment-\d{6}\.ts$/;

let streamLoopStarted = false;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function prepareHlsDirectory(): Promise<void> {
  await mkdir(HLS_DIRECTORY, { recursive: true });
  const oldFiles = await readdir(HLS_DIRECTORY);
  await Promise.all(
    oldFiles
      .filter((file) => file === "playlist.m3u8" || SEGMENT_PATTERN_REGEX.test(file))
      .map((file) => unlink(join(HLS_DIRECTORY, file)).catch(() => undefined)),
  );
}

async function runFfmpegConnection(): Promise<void> {
  const { response, controller } = await openFreshRadioAudio();
  if (!response.body) {
    controller.abort();
    throw new Error("Radio provider returned an empty audio stream");
  }

  const input = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-fflags", "+genpts",
    "-i", "pipe:0",
    "-vn",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-ar", "44100",
    "-f", "hls",
    "-hls_time", "3",
    "-hls_list_size", "8",
    "-hls_delete_threshold", "3",
    "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
    "-hls_segment_filename", SEGMENT_PATTERN,
    PLAYLIST_PATH,
  ], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  ffmpeg.stderr?.resume();

  const ffmpegInput = ffmpeg.stdin;
  if (!ffmpegInput) {
    controller.abort();
    input.destroy();
    throw new Error("FFmpeg input pipe was not created");
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanUp = () => {
      if (idleTimer) clearTimeout(idleTimer);
      controller.abort();
      input.destroy();
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      cleanUp();
      resolve();
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.warn("Radio input stopped delivering audio; reconnecting");
        controller.abort();
        input.destroy();
        if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
      }, INPUT_IDLE_TIMEOUT_MS);
    };

    input.on("data", resetIdleTimer);
    input.once("error", () => {
      if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
    });
    ffmpegInput.on("error", () => {
      if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
    });
    ffmpeg.once("error", (error) => {
      logger.warn({ err: error }, "FFmpeg could not start the live radio encoder");
      finish();
    });
    ffmpeg.once("close", (code, signal) => {
      if (code !== 0 && code !== null) {
        logger.warn({ code, signal }, "Live radio encoder stopped; reconnecting");
      }
      finish();
    });

    resetIdleTimer();
    input.pipe(ffmpegInput);
  });
}

async function runStreamLoop(): Promise<void> {
  await prepareHlsDirectory();

  let retryDelayMs = 1000;
  while (true) {
    const startedAt = Date.now();
    try {
      await runFfmpegConnection();
    } catch (error) {
      logger.warn({ err: error }, "Unable to create the live radio segments");
    }

    const connectionDuration = Date.now() - startedAt;
    if (connectionDuration > 60000) {
      retryDelayMs = 1000;
    } else {
      retryDelayMs = Math.min(retryDelayMs * 2, 15000);
    }
    await wait(retryDelayMs);
  }
}

export function ensureRadioHlsRunning(): void {
  if (streamLoopStarted) return;
  streamLoopStarted = true;
  void runStreamLoop().catch((error) => {
    streamLoopStarted = false;
    logger.error({ err: error }, "Live radio segment service failed to start");
    setTimeout(ensureRadioHlsRunning, 3000);
  });
}

export async function waitForRadioHlsPlaylist(timeoutMs = 12000): Promise<boolean> {
  ensureRadioHlsRunning();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const file = await stat(PLAYLIST_PATH);
      if (file.size > 0) return true;
    } catch {
      // The encoder has not published its first playlist yet.
    }
    await wait(250);
  }

  return false;
}

export function getRadioHlsFilePath(filename: string): string | null {
  if (filename === "playlist.m3u8") return PLAYLIST_PATH;
  if (SEGMENT_PATTERN_REGEX.test(filename)) return join(HLS_DIRECTORY, filename);
  return null;
}
