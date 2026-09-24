import React, { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause, Volume2, VolumeX, Radio, Copy, Check, Share2, RefreshCw, WifiOff, Download, X, ArrowUp } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import logoSrc from "@assets/usalbradio_1775675611808.jpg";
import { SiFacebook, SiWhatsapp, SiX, SiMessenger } from "react-icons/si";

const ua = navigator.userAgent;
const isIOS = /iP(hone|ad|od)/.test(ua);
const isAndroid = /Android/.test(ua);
const isInAppBrowser = /FBAN|FBAV|FBIOS|FB_IAB|Instagram|Messenger|TikTok|musical_ly|Line\//i.test(ua);
const isStandaloneDisplay = window.matchMedia("(display-mode: standalone)").matches
  || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
const STREAM_ENDPOINT = "/api/stream";
const OFFICIAL_RADIO_PAGE = "https://usalbradio.radiostream321.com/";
const PUBLIC_APP_URL = "https://usalb-radio-usalbtv--applauncher2.replit.app/";

const isAutoplayBlockedError = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; code?: number; message?: string };
  return candidate.name === "NotAllowedError"
    || candidate.code === 9
    || /autoplay|user.?gesture|play\(\).*not allowed/i.test(candidate.message ?? "");
};

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export default function Home() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [streamOffline, setStreamOffline] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [installHelpMode, setInstallHelpMode] = useState<"steps" | "external" | "fallback">("steps");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(isStandaloneDisplay);
  const shareRef = useRef<HTMLDivElement>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const primerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const warmupIframeRef = useRef<HTMLIFrameElement | null>(null);
  const playAttemptRef = useRef(false);
  const streamOfflineRef = useRef(false);
  const hasPlayedOnceRef = useRef(false);
  const autoplayBlockedRef = useRef(false);
  useEffect(() => { streamOfflineRef.current = streamOffline; }, [streamOffline]);

  // Use a ref for the stream URL so updating it NEVER causes a re-render
  // or audio interruption. The audio element src is set imperatively.
  const streamUrlRef = useRef("");
  const streamUrlRequestRef = useRef<Promise<string> | null>(null);
  const isPlayingRef = useRef(false);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const handleInstalled = () => {
      setInstallPrompt(null);
      setIsInstalled(true);
      setShowInstallHelp(false);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  // Wake the API and resolve the current provider mount as soon as the
  // listener opens USALB. This is important after a Replit cold start: the
  // first visitor should trigger the server-side resolver automatically
  // instead of having to open RadioStream321 manually.
  useEffect(() => {
    let cancelled = false;

    const warmServer = async () => {
      try {
        const response = await fetch("/api/stream-url?fresh=1", {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok || cancelled) return;
        const data = await response.json() as { url?: string };
        if (data.url && !cancelled) {
          streamUrlRef.current = data.url;
        }
      } catch {
        // Playback will retry through /api/stream when the user presses Play.
      }
    };

    void warmServer();
    const retry = window.setTimeout(() => void warmServer(), 4000);

    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, []);

  // Listen2MyRadio initializes the station when its official player page is
  // opened. Warm it up invisibly on app launch so the first Play tap does not
  // depend on the user visiting that page beforehand.
  useEffect(() => {
    const iframe = document.createElement("iframe");
    iframe.src = OFFICIAL_RADIO_PAGE;
    iframe.title = "Radio connection warm-up";
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("allow", "autoplay");
    iframe.style.position = "fixed";
    iframe.style.width = "1px";
    iframe.style.height = "1px";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    iframe.style.border = "0";
    warmupIframeRef.current = iframe;
    document.body.appendChild(iframe);

    const cleanupTimer = window.setTimeout(() => {
      iframe.remove();
      if (warmupIframeRef.current === iframe) warmupIframeRef.current = null;
    }, 1500);

    return () => {
      window.clearTimeout(cleanupTimer);
      iframe.remove();
      if (warmupIframeRef.current === iframe) warmupIframeRef.current = null;
    };
  }, []);

  // Always share the public production URL. A temporary .replit.dev preview
  // URL makes Messenger open Replit's placeholder instead of this app.
  const shareUrl = PUBLIC_APP_URL;
  const shareText = "Listen to USALB RADIO — live Albanian broadcast!";

  const handleInstall = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setInstallPrompt(null);
      return;
    }
    if ((isIOS || isAndroid) && isInAppBrowser) {
      setInstallHelpMode("external");
      setShowInstallHelp(true);
      return;
    }
    setInstallHelpMode("steps");
    setShowInstallHelp(true);
  };

  const openExternalBrowser = () => {
    const currentUrl = window.location.href;
    if (isAndroid) {
      const browserUrl = currentUrl.replace(/^https?:\/\//i, "");
      window.location.href = `intent://${browserUrl}#Intent;scheme=https;package=com.android.chrome;end`;
    } else {
      // Messenger and other iOS webviews keep ordinary https links inside
      // themselves. The Safari URL scheme is the best available handoff.
      const safariUrl = currentUrl.replace(/^https?:\/\//i, "");
      window.location.href = `x-safari-https://${safariUrl}`;
    }
    window.setTimeout(() => {
      if (document.visibilityState === "visible") setInstallHelpMode("fallback");
    }, 900);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const shareOn = async (platform: "facebook" | "messenger" | "whatsapp" | "x") => {
    // Facebook's web share page can render as a blank Messenger web view.
    // Try the Facebook app directly when this page is already inside an
    // in-app browser, then fall back to Facebook's web sharer if needed.
    if (platform === "facebook" && isInAppBrowser) {
      const facebookWebUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
      window.location.href = `fb://share?link=${encodeURIComponent(shareUrl)}`;
      setShareOpen(false);
      window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          window.location.href = facebookWebUrl;
        }
      }, 900);
      return;
    }

    // Messenger works best through its native app URL. The Web Share API
    // opens a second Messenger web view on iOS, which can remain blank.
    if (platform === "messenger") {
      // If the page is already inside Messenger, launching Messenger again
      // can leave the embedded browser stuck on "Loading".
      if (isInAppBrowser) {
        copyLink();
        return;
      }

      const messengerUrl = `fb-messenger://share/?link=${encodeURIComponent(shareUrl)}`;
      window.location.href = messengerUrl;
      setShareOpen(false);
      return;
    }

    // On phones, use the operating system share sheet. This avoids opening
    // unreliable social web views and lets the user choose the installed app.
    if (isIOS || isAndroid) {
      try {
        if (navigator.share) {
          await navigator.share({
            title: "USALB RADIO",
            text: shareText,
            url: shareUrl,
          });
          setShareOpen(false);
          return;
        }
      } catch (error) {
        // Closing the native share sheet is not an error.
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }

    const urls = {
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
      messenger: `https://www.messenger.com/share?link=${encodeURIComponent(shareUrl)}`,
      whatsapp: `https://wa.me/?text=${encodeURIComponent(shareText + " " + shareUrl)}`,
      x: `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`,
    };
    window.open(urls[platform], "_blank", "noopener,noreferrer");
    setShareOpen(false);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // Some in-app browsers do not expose navigator.clipboard.
      const input = document.createElement("textarea");
      input.value = shareUrl;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.focus();
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    setShareOpen(false);
    setTimeout(() => setCopied(false), 2000);
  };
  
  const clearRetryTimers = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    setRetryCountdown(0);
  }, []);

  const startRetryCountdown = useCallback((seconds: number, onRetry: () => void) => {
    clearRetryTimers();
    setRetryCountdown(seconds);
    countdownRef.current = setInterval(() => {
      setRetryCountdown((n) => {
        if (n <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    retryTimerRef.current = setTimeout(onRetry, seconds * 1000);
  }, [clearRetryTimers]);

  const removePrimerIframe = useCallback(() => {
    if (primerIframeRef.current) {
      primerIframeRef.current.src = "about:blank";
      primerIframeRef.current.remove();
      primerIframeRef.current = null;
    }
  }, []);

  const primerAndPlay = useCallback(async (audio: HTMLAudioElement, url: string) => {
    // Retry the stream directly. The hidden warm-up iframe added delay and was
    // unreliable inside Messenger's embedded browser.
    removePrimerIframe();
    audio.src = url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
    audio.load();
    await audio.play();
  }, [removePrimerIframe]);

  const playThroughStreamEndpoint = useCallback(async (
    audio: HTMLAudioElement,
    forceFresh = false,
  ) => {
    // Always use the same-origin proxy for playback. Sending Messenger's
    // embedded browser directly to the third-party provider can be rejected
    // even when the same audio works in Safari. The proxy also supplies the
    // provider's rotating URL and session headers server-side.
    audio.src = `${STREAM_ENDPOINT}?_t=${Date.now()}${forceFresh ? "&fresh=1" : ""}`;
    audio.load();
    // Keep play() in the same call stack as the user's tap. The endpoint
    // resolves the rotating provider URL server-side after playback begins.
    await audio.play();
  }, []);

  const loadStreamUrl = useCallback(async (forceFresh = false) => {
    if (!forceFresh && streamUrlRef.current) return streamUrlRef.current;
    if (streamUrlRequestRef.current) return streamUrlRequestRef.current;

    const request = fetch(`/api/stream-url${forceFresh ? "?fresh=1" : ""}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Stream URL unavailable");
        const data = await res.json() as { url?: string };
        if (!data.url) throw new Error("Stream URL missing");
        streamUrlRef.current = data.url;
        return data.url;
      })
      .finally(() => {
        streamUrlRequestRef.current = null;
      });

    streamUrlRequestRef.current = request;
    return request;
  }, []);

  const attemptPlay = useCallback(async (isRetry = false, fromUserGesture = false) => {
    const audio = audioRef.current;
    if (!audio || playAttemptRef.current) return;
    if (autoplayBlockedRef.current && !fromUserGesture) return;
    playAttemptRef.current = true;
    setIsLoading(true);
    try {
      // If this came from a tap, start the audio element before awaiting any
      // network work. Mobile Safari and some Android webviews otherwise lose
      // the user-gesture permission required by audio.play().
      if (fromUserGesture) {
        await playThroughStreamEndpoint(audio, isRetry);
      } else {
        const streamUrl = await loadStreamUrl(isRetry);
        if (isRetry) {
          await primerAndPlay(audio, streamUrl);
        } else {
          audio.src = streamUrl;
          audio.load();
          await audio.play();
        }
      }
      setIsPlaying(true);
      hasPlayedOnceRef.current = true;
      autoplayBlockedRef.current = false;
      setStreamOffline(false);
      setAutoplayBlocked(false);
      clearRetryTimers();
    } catch (error) {
      // A stale provider URL should be discarded so the next tap/retry gets a
      // fresh stream address rather than replaying the same failed URL.
      if (!isAutoplayBlockedError(error)) {
        streamUrlRef.current = "";
      }
      removePrimerIframe();
      setIsPlaying(false);
      // Browser autoplay restrictions are not a station outage. Explain the
      // required user action instead of showing a misleading reconnect loop.
      if (isAutoplayBlockedError(error)) {
        autoplayBlockedRef.current = true;
        setAutoplayBlocked(true);
        setStreamOffline(false);
        clearRetryTimers();
      } else {
        setStreamOffline(true);
        // Three seconds keeps the first connection feeling direct while still
        // allowing the station provider time to become ready.
        startRetryCountdown(3, () => attemptPlay(true));
      }
    } finally {
      playAttemptRef.current = false;
      setIsLoading(false);
    }
  }, [clearRetryTimers, startRetryCountdown, primerAndPlay, removePrimerIframe, loadStreamUrl, playThroughStreamEndpoint]);

  // Resolve the rotating station URL ahead of time so a later user tap can
  // start playback synchronously without waiting for fetch().
  useEffect(() => {
    void loadStreamUrl().catch(() => undefined);
  }, [loadStreamUrl]);

  // Media Session keeps Android Chrome's lock-screen notification and headset
  // controls connected to the live player while the page is in the background.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: "USALB RADIO",
      artist: "Live Albanian Broadcast",
      album: "USALB RADIO",
      artwork: [{
        src: new URL("/og-image.jpg", window.location.origin).href,
        sizes: "1200x630",
        type: "image/jpeg",
      }],
    });

    const playFromMediaSession = () => {
      if (!isPlayingRef.current) attemptPlay(false, true);
    };
    const pauseFromMediaSession = () => {
      audioRef.current?.pause();
      setIsPlaying(false);
      clearRetryTimers();
    };

    navigator.mediaSession.setActionHandler("play", playFromMediaSession);
    navigator.mediaSession.setActionHandler("pause", pauseFromMediaSession);
    navigator.mediaSession.setActionHandler("stop", pauseFromMediaSession);

    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("stop", null);
    };
  }, [attemptPlay, clearRetryTimers]);

  const togglePlay = () => {
    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      clearRetryTimers();
      setStreamOffline(false);
      removePrimerIframe();
    } else {
      autoplayBlockedRef.current = false;
      setAutoplayBlocked(false);
      attemptPlay(streamOffline, true);
    }
  };

  const handleVolumeChange = (value: number[]) => {
    const newVolume = value[0];
    setVolume(newVolume);
    if (audioRef.current) {
      audioRef.current.volume = newVolume;
    }
    if (newVolume === 0) {
      setIsMuted(true);
    } else if (isMuted) {
      setIsMuted(false);
    }
  };

  const toggleMute = () => {
    if (audioRef.current) {
      if (isMuted) {
        audioRef.current.volume = volume || 0.5;
        setIsMuted(false);
        if (volume === 0) setVolume(0.5);
      } else {
        audioRef.current.volume = 0;
        setIsMuted(true);
      }
    }
  };

  // Keep the audio element configured without attempting autoplay. An
  // autoplay attempt can occupy the player while a user is tapping Play and
  // can make some mobile browsers reject the real user-initiated start.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
  }, [volume]);

  // Listen for mid-stream errors and disconnects
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleError = () => {
      // A failed initial load is handled by attemptPlay with the 10-second
      // startup retry. Only use the faster retry after real playback began.
      if (!isPlayingRef.current || streamOfflineRef.current) return;
      setIsPlaying(false);
      setIsLoading(false);
      setStreamOffline(true);
      startRetryCountdown(3, () => attemptPlay(true));
    };
    const handleStall = () => {
      // Browsers can emit "stalled" while the first connection is still
      // being established. Do not turn that startup failure into a 3-second
      // loop or compete with attemptPlay's 10-second retry.
      if (!isPlayingRef.current || streamOfflineRef.current) return;
      const stallTimeout = setTimeout(() => {
        if (isPlayingRef.current && !streamOfflineRef.current) {
          audio.pause();
          setIsPlaying(false);
          setStreamOffline(true);
          startRetryCountdown(3, () => attemptPlay(true));
        }
      }, 5000);
      const onPlaying = () => clearTimeout(stallTimeout);
      audio.addEventListener("playing", onPlaying, { once: true });
    };
    audio.addEventListener("error", handleError);
    audio.addEventListener("stalled", handleStall);
    return () => {
      audio.removeEventListener("error", handleError);
      audio.removeEventListener("stalled", handleStall);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptPlay, startRetryCountdown]);

  // Reconnect automatically when the user returns to this tab while offline
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && (
        streamOfflineRef.current || (isPlayingRef.current && audioRef.current?.paused)
      )) {
        clearRetryTimers();
        attemptPlay(streamOfflineRef.current);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptPlay, clearRetryTimers]);

  return (
    <div className="min-h-[100dvh] bg-black text-white flex flex-col items-center justify-center relative overflow-hidden font-sans">
       {/* Install banner explains the platform-specific install flow. */}
      {!isInstalled && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-[#1877F2] px-4 py-3 flex items-center justify-between gap-3 shadow-lg">
          <p className="text-white text-sm font-medium leading-tight">
             Add USALB RADIO for quick access and background playback.
          </p>
          <button
            onClick={handleInstall}
            data-testid="button-download-app"
            className="shrink-0 bg-white text-[#1877F2] text-sm font-bold px-4 py-1.5 rounded-full hover:bg-gray-100 transition-colors"
          >
             <span className="inline-flex items-center gap-1.5"><Download className="w-4 h-4" />Download App</span>
          </button>
        </div>
      )}

      {/* Installation instructions for iOS, Android, and unsupported desktop browsers */}
      {showInstallHelp && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowInstallHelp(false)}>
          <div className="bg-[#1c1c1e] rounded-t-3xl w-full max-w-md p-6 pb-10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-6" />
            <button
              onClick={() => setShowInstallHelp(false)}
              aria-label="Close installation instructions"
              className="absolute right-5 top-5 text-gray-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
            {installHelpMode === "external" ? (
              <>
                <h2 className="text-white text-xl font-semibold mb-3 text-center">
                  {isIOS ? "Open USALB RADIO in Safari" : "Open USALB RADIO in your browser"}
                </h2>
                <p className="text-gray-300 text-sm text-center mb-6">
                  {isIOS
                    ? "To install USALB RADIO, first open it in Safari."
                    : "To install USALB RADIO, first open it in Chrome or your browser."}
                </p>
                <button
                  onClick={openExternalBrowser}
                  className="w-full py-4 rounded-2xl bg-red-600 text-white text-base font-semibold hover:bg-red-500 transition-colors shadow-lg shadow-red-950/40"
                >
                  {isIOS ? "Open in Safari" : "Open in Chrome"}
                </button>
              </>
            ) : installHelpMode === "fallback" ? (
              <>
                <div className="flex justify-center mb-2 text-red-500">
                  <ArrowUp className="w-10 h-10 animate-bounce" />
                </div>
                <h2 className="text-white text-xl font-semibold mb-2 text-center">Almost there!</h2>
                <p className="text-gray-300 text-base text-center leading-relaxed mb-6">
                  Tap the <strong className="text-white">•••</strong> button at the top,
                  <br />
                  then tap <strong className="text-white">Open in Browser</strong>.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-white text-lg font-semibold mb-2 text-center">
                  {isIOS ? "Install USALB RADIO on iPhone" : "Install USALB RADIO"}
                </h2>
                <p className="text-gray-400 text-sm text-center mb-6">
                  {isIOS
                    ? "In Safari, follow these simple steps:"
                    : "Use your browser's install option to add the radio to your home screen:"}
                </p>
                <ol className="space-y-4 mb-8">
                  <li className="flex items-start gap-3">
                    <span className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-white text-sm font-bold shrink-0">1</span>
                    <p className="text-white text-sm pt-1">
                      {isIOS ? <>Tap the <strong>Share</strong> button</> : <>Open your browser menu</>}
                    </p>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-white text-sm font-bold shrink-0">2</span>
                    <p className="text-white text-sm pt-1">
                      {isIOS ? <>Tap <strong>Add to Home Screen</strong></> : <>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong></>}
                    </p>
                  </li>
                  {isIOS && (
                    <li className="flex items-start gap-3">
                      <span className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-white text-sm font-bold shrink-0">3</span>
                      <p className="text-white text-sm pt-1">Tap <strong>Add</strong></p>
                    </li>
                  )}
                </ol>
              </>
            )}
            <button onClick={() => setShowInstallHelp(false)} className="w-full py-3 rounded-2xl bg-white/10 text-white text-sm font-medium hover:bg-white/20 transition-colors">
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Background Ambience */}
      <div className="absolute inset-0 z-0">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-red-900/20 rounded-full blur-[120px] pointer-events-none mix-blend-screen opacity-50" />
        <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-black via-[#0a0a0a] to-[#120000] z-0" />
      </div>

      <div className="relative z-10 w-full max-w-md mx-auto p-8">
        {/* Player Card */}
        <div className="bg-[#111] border border-red-900/30 rounded-3xl p-8 shadow-[0_0_50px_-12px_rgba(255,0,0,0.2)] backdrop-blur-xl relative overflow-hidden group">
          {/* Subtle animated glow inside card */}
          <div className={cn(
            "absolute -inset-20 bg-gradient-to-tr from-red-600/10 to-transparent blur-2xl opacity-0 transition-opacity duration-1000",
            isPlaying && "opacity-100 animate-pulse-fast"
          )} />
          
          <div className="relative z-10 flex flex-col items-center">
            {/* Live Indicator */}
            <div className="flex items-center gap-2 mb-8 bg-black/50 px-4 py-1.5 rounded-full border border-red-900/50">
              <div className={cn(
                "w-2.5 h-2.5 rounded-full bg-red-600",
                isPlaying ? "animate-pulse shadow-[0_0_10px_rgba(220,38,38,0.8)]" : "opacity-50"
              )} />
              <span className="text-xs font-medium tracking-widest text-red-50 uppercase">
                Live Broadcast
              </span>
            </div>

            {/* Station logo — the circular USALB Radio mark from the station branding */}
            <div className="mb-12 flex justify-center">
              <div
                className="relative flex h-44 w-44 items-center justify-center overflow-hidden rounded-full border border-red-500/40 bg-black/80 p-2 shadow-[0_0_45px_-10px_rgba(220,38,38,0.45)] sm:h-52 sm:w-52"
                data-testid="station-logo-frame"
              >
                <div className="absolute inset-0 rounded-full border border-white/10" />
                <img
                  src={logoSrc}
                  alt="USALB RADIO"
                  className="relative h-full w-full rounded-full object-contain"
                  data-testid="img-logo"
                />
              </div>
            </div>

            {/* Visualizer (Fake) */}
            <div className="h-16 flex items-end justify-center gap-1.5 mb-12 w-full px-8">
              {Array.from({ length: 24 }).map((_, i) => (
                <div 
                  key={i}
                  className={cn(
                    "w-1.5 bg-red-600/80 rounded-t-sm transition-all duration-300 origin-bottom",
                    !isPlaying && "h-1"
                  )}
                  style={isPlaying ? {
                    height: `${Math.max(10, Math.random() * 100)}%`,
                    animation: `equalizer ${0.5 + Math.random() * 1}s ease-in-out infinite alternate`,
                    animationDelay: `${Math.random() * -2}s`
                  } : {}}
                />
              ))}
            </div>

            {/* Play Button */}
            <button
               // pointerdown runs at the start of the phone's touch gesture.
               // This is more reliable than waiting for click in Messenger's
               // iOS webview, where the activation window is very short.
               onPointerDown={togglePlay}
               onKeyDown={(event) => {
                 if (event.key === "Enter" || event.key === " ") togglePlay();
               }}
              className={cn(
                "w-28 h-28 rounded-full flex items-center justify-center transition-all duration-500 relative group/btn mb-4",
                isPlaying 
                  ? "bg-red-700 hover:bg-red-600 text-white shadow-[0_0_40px_rgba(220,38,38,0.5)]" 
                  : streamOffline
                  ? "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white"
                  : "bg-white text-red-700 hover:bg-gray-100 hover:scale-105 shadow-[0_0_30px_rgba(255,255,255,0.1)]"
              )}
            >
              {isLoading ? (
                <div className="w-10 h-10 border-4 border-current border-t-transparent rounded-full animate-spin" />
              ) : isPlaying ? (
                <Pause className="w-12 h-12 fill-current" />
              ) : streamOffline ? (
                <RefreshCw className="w-10 h-10" />
              ) : (
                <Play className="w-12 h-12 fill-current ml-2" />
              )}
              
              {/* Ripple Effect when playing */}
              {isPlaying && (
                <div className="absolute inset-0 rounded-full border border-red-500 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] opacity-75" />
              )}
            </button>

            {/* Startup guidance and reconnect status */}
            {autoplayBlocked && !isLoading && !isPlaying && (
              <div className="mb-8 w-full rounded-2xl border border-red-500/30 bg-red-950/40 px-4 py-4 text-center">
                <p className="text-sm font-semibold text-white">Ready to play</p>
                <p className="mt-1 text-xs leading-relaxed text-red-100/70">
                   {isInAppBrowser
                     ? "Messenger blocked audio in its built-in browser. Open this page in Safari, then press Play."
                     : "Your browser blocked automatic playback. Tap the play button to start the live radio."}
                </p>
                 {isInAppBrowser && (
                   <button
                     type="button"
                     onClick={openExternalBrowser}
                     className="mt-3 rounded-full bg-white px-4 py-2 text-xs font-bold text-red-900 transition-colors hover:bg-red-50"
                   >
                     Open in Safari
                   </button>
                 )}
              </div>
            )}
            {streamOffline && !isLoading && (
              <div className="mb-8 flex flex-col items-center gap-2 text-center">
                <div className="flex items-center gap-2 text-yellow-500">
                  {hasPlayedOnceRef.current ? <WifiOff className="w-4 h-4" /> : <Radio className="w-4 h-4 animate-pulse" />}
                  <span className="text-sm font-medium">
                    {hasPlayedOnceRef.current ? "Stream temporarily offline" : "Connecting to live radio"}
                  </span>
                </div>
                {retryCountdown > 0 ? (
                  <p className="text-xs text-gray-500">
                    {hasPlayedOnceRef.current ? "Retrying" : "Trying again"} in{" "}
                    <span className="text-gray-300 font-medium">{retryCountdown}s</span> — or tap above to retry now
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">
                    {hasPlayedOnceRef.current ? "Tap the button above to retry" : "The radio will keep trying automatically"}
                  </p>
                )}
              </div>
            )}
            {!streamOffline && !autoplayBlocked && <div className="mb-8" />}

            {/* Volume Control */}
            {isIOS ? (
              <div className="w-full flex items-center justify-center gap-3 bg-black/40 p-4 rounded-2xl border border-white/5">
                <Volume2 className="w-5 h-5 text-gray-400 shrink-0" />
                <span className="text-gray-400 text-sm text-center">
                  Use your phone's volume buttons to adjust
                </span>
              </div>
            ) : (
              <div className="w-full flex items-center gap-4 bg-black/40 p-4 rounded-2xl border border-white/5">
                <button 
                  onClick={toggleMute}
                  className="text-gray-400 hover:text-white transition-colors"
                  data-testid="button-mute"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-5 h-5" />
                  ) : (
                    <Volume2 className="w-5 h-5" />
                  )}
                </button>
                <Slider
                  value={[isMuted ? 0 : volume]}
                  max={1}
                  step={0.01}
                  onValueChange={handleVolumeChange}
                  className="cursor-pointer"
                  data-testid="slider-volume"
                />
              </div>
            )}
            {/* Share Button + Popup */}
            <div className="w-full mt-6 relative" ref={shareRef}>
              <button
                onClick={() => setShareOpen((o) => !o)}
                data-testid="button-share"
                className={cn(
                  "w-full flex items-center justify-center gap-2 py-3 rounded-2xl border text-sm font-medium transition-all duration-200",
                  shareOpen
                    ? "bg-white/10 border-white/20 text-white"
                    : "bg-white/5 border-white/10 text-gray-300 hover:bg-white/10 hover:text-white"
                )}
              >
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Share2 className="w-4 h-4" />}
                {copied ? "Link copied!" : "Share"}
              </button>

              {shareOpen && (
                <div className="absolute bottom-full left-0 right-0 mb-3 bg-[#1a1a1a] border border-white/10 rounded-2xl overflow-hidden shadow-[0_-8px_30px_rgba(0,0,0,0.5)] z-50">
                  <p className="text-center text-xs text-gray-500 uppercase tracking-widest py-3 border-b border-white/5">
                    Share via
                  </p>
                  <div className="p-2 flex flex-col gap-1">
                    <button
                      onClick={() => shareOn("facebook")}
                      data-testid="button-share-facebook"
                      className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-white/5 transition-colors text-left w-full"
                    >
                      <div className="w-9 h-9 rounded-full bg-[#1877F2] flex items-center justify-center shrink-0">
                        <SiFacebook className="w-4 h-4 text-white" />
                      </div>
                      <span className="text-white font-medium text-sm">Facebook</span>
                    </button>
                    <button
                      onClick={() => shareOn("messenger")}
                      data-testid="button-share-messenger"
                      className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-white/5 transition-colors text-left w-full"
                    >
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#00B2FF] to-[#006AFF] flex items-center justify-center shrink-0">
                        <SiMessenger className="w-4 h-4 text-white" />
                      </div>
                       <span className="text-white font-medium text-sm">
                         {isInAppBrowser ? "Copy link for Messenger" : "Open Messenger"} 
                       </span>
                    </button>
                    <button
                      onClick={() => shareOn("whatsapp")}
                      data-testid="button-share-whatsapp"
                      className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-white/5 transition-colors text-left w-full"
                    >
                      <div className="w-9 h-9 rounded-full bg-[#25D366] flex items-center justify-center shrink-0">
                        <SiWhatsapp className="w-4 h-4 text-white" />
                      </div>
                      <span className="text-white font-medium text-sm">WhatsApp</span>
                    </button>
                    <button
                      onClick={() => shareOn("x")}
                      data-testid="button-share-x"
                      className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-white/5 transition-colors text-left w-full"
                    >
                      <div className="w-9 h-9 rounded-full bg-black border border-white/20 flex items-center justify-center shrink-0">
                        <SiX className="w-4 h-4 text-white" />
                      </div>
                      <span className="text-white font-medium text-sm">X</span>
                    </button>
                    <button
                      onClick={copyLink}
                      data-testid="button-copy-link"
                      className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-white/5 transition-colors text-left w-full"
                    >
                      <div className={cn(
                        "w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors",
                        copied ? "bg-green-500" : "bg-white/10"
                      )}>
                        {copied ? <Check className="w-4 h-4 text-white" /> : <Copy className="w-4 h-4 text-white" />}
                      </div>
                      <span className="text-white font-medium text-sm">{copied ? "Copied!" : "Copy link"}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer info */}
        <div className="mt-8 text-center flex items-center justify-center gap-2 text-gray-500 text-xs">
          <Radio className="w-3 h-3" />
          <span>High Quality Audio Stream</span>
        </div>
      </div>

      <audio 
        ref={audioRef} 
        preload="auto"
        playsInline
      />
    </div>
  );
}
