import React, { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause, Volume2, VolumeX, Radio, Copy, Check, Share2, RefreshCw, WifiOff } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import logoSrc from "@assets/usalbradio_1775675611808.jpg";
import { SiFacebook, SiWhatsapp, SiX, SiMessenger } from "react-icons/si";

const FALLBACK_STREAM_URL = "https://uk4freenew.listen2myradio.com/live.mp3?typeportmount=s1_9311_stream_687568716";

const ua = navigator.userAgent;
const isIOS = /iP(hone|ad|od)/.test(ua);
const isAndroid = /Android/.test(ua);
const isInFBBrowser = /FBAN|FBAV|FBIOS|FB_IAB|Instagram|Messenger/.test(ua);

function openInSystemBrowser(url: string, setShowIOSHelp: (v: boolean) => void) {
  if (isAndroid) {
    // Open this exact shared page in Android's default browser.
    const destination = new URL(url);
    const intentTarget = `${destination.host}${destination.pathname}${destination.search}${destination.hash}`;
    window.location.href = `intent://${intentTarget}#Intent;scheme=https;end`;
  } else if (isIOS) {
    // iOS: can't open Safari programmatically — show step-by-step instructions
    setShowIOSHelp(true);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export default function Home() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [streamOffline, setStreamOffline] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [showIOSHelp, setShowIOSHelp] = useState(false);
  const shareRef = useRef<HTMLDivElement>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const primerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const streamOfflineRef = useRef(false);
  useEffect(() => { streamOfflineRef.current = streamOffline; }, [streamOffline]);

  // Use a ref for the stream URL so updating it NEVER causes a re-render
  // or audio interruption. The audio element src is set imperatively.
  const streamUrlRef = useRef(FALLBACK_STREAM_URL);
  const isPlayingRef = useRef(false);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const shareUrl = window.location.href;
  const shareText = "Listen to USALB RADIO — live Albanian broadcast!";

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Fetch the live stream URL. Store it in a ref only.
  // If the radio is already playing, leave it completely alone.
  // If not playing, update the audio src so the next play uses the fresh URL.
  useEffect(() => {
    let cancelled = false;
    const fetchUrl = async () => {
      try {
        const res = await fetch("/api/stream-url");
        if (!res.ok) throw new Error("API error");
        const data = await res.json();
        if (cancelled || !data.url) return;
        streamUrlRef.current = data.url;
        // Only update the audio element src if the radio is not currently playing
        if (audioRef.current && !isPlayingRef.current) {
          audioRef.current.src = data.url;
        }
      } catch {
        // Keep the fallback already set on the audio element
      }
    };
    fetchUrl();
    const interval = setInterval(fetchUrl, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const shareOn = async (platform: "facebook" | "messenger" | "whatsapp" | "x") => {
    // Messenger works best through its native app URL. The Web Share API
    // opens a second Messenger web view on iOS, which can remain blank.
    if (platform === "messenger") {
      // If the page is already inside Messenger, launching Messenger again
      // can leave the embedded browser stuck on "Loading".
      if (isInFBBrowser) {
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
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
        }
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
      x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`,
    };
    window.open(urls[platform], "_blank", "noopener,noreferrer");
    setShareOpen(false);
  };

  const copyLink = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setShareOpen(false);
      setTimeout(() => setCopied(false), 2000);
    });
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

  const attemptPlay = useCallback(async (isRetry = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    // Fetch fresh URL before each play attempt; bust server cache on retries
    try {
      const qs = isRetry ? "?fresh=1" : "";
      const res = await fetch(`/api/stream-url${qs}`);
      if (res.ok) {
        const data = await res.json();
        if (data.url) {
          streamUrlRef.current = data.url;
        }
      }
    } catch { /* use existing url */ }

    setIsLoading(true);
    setStreamOffline(false);
    try {
      if (isRetry) {
        await primerAndPlay(audio, streamUrlRef.current);
      } else {
        audio.src = streamUrlRef.current;
        audio.load();
        await audio.play();
      }
      setIsPlaying(true);
      setIsLoading(false);
      clearRetryTimers();
    } catch {
      removePrimerIframe();
      setIsLoading(false);
      setIsPlaying(false);
      setStreamOffline(true);
       startRetryCountdown(3, () => attemptPlay(true));
    }
  }, [clearRetryTimers, startRetryCountdown, primerAndPlay, removePrimerIframe]);

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
      if (!isPlayingRef.current) attemptPlay(false);
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
      attemptPlay(streamOffline);
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

  // Attempt autoplay once on mount.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.autoplay = true;

    const tryAutoplay = () => {
      if (!audio.paused) return;
      audio.play().then(() => {
        setIsPlaying(true);
        setIsLoading(false);
      }).catch(() => {});
    };

    // Try immediately, then retry after the first touch/click. The second
    // attempt satisfies browsers that block sound until user interaction.
    tryAutoplay();
    window.addEventListener("pointerdown", tryAutoplay, { once: true });
    window.addEventListener("touchstart", tryAutoplay, { once: true });
    return () => {
      window.removeEventListener("pointerdown", tryAutoplay);
      window.removeEventListener("touchstart", tryAutoplay);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for mid-stream errors and disconnects
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleError = () => {
      if (!isPlayingRef.current) return;
      setIsPlaying(false);
      setIsLoading(false);
      setStreamOffline(true);
       startRetryCountdown(3, () => attemptPlay(true));
    };
    const handleStall = () => {
      const stallTimeout = setTimeout(() => {
        if (isPlayingRef.current) {
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
      {/* Open-in-Browser Banner — only visible inside Facebook / Messenger */}
      {isInFBBrowser && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-[#1877F2] px-4 py-3 flex items-center justify-between gap-3 shadow-lg">
          <p className="text-white text-sm font-medium leading-tight">
            For the best experience and sound, open in your browser.
          </p>
          <button
            onClick={() => openInSystemBrowser(shareUrl, setShowIOSHelp)}
            data-testid="button-open-in-browser"
            className="shrink-0 bg-white text-[#1877F2] text-sm font-bold px-4 py-1.5 rounded-full hover:bg-gray-100 transition-colors"
          >
            Open
          </button>
        </div>
      )}

      {/* iOS Safari Instructions Modal */}
      {showIOSHelp && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowIOSHelp(false)}>
          <div className="bg-[#1c1c1e] rounded-t-3xl w-full max-w-md p-6 pb-10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-6" />
            <h2 className="text-white text-lg font-semibold mb-2 text-center">Open in Safari</h2>
            <p className="text-gray-400 text-sm text-center mb-6">Facebook can't open Safari directly. Follow these steps:</p>
            <ol className="space-y-4 mb-8">
              <li className="flex items-start gap-3">
                <span className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center text-white text-xs font-bold shrink-0">1</span>
                <p className="text-white text-sm pt-0.5">Tap the <strong>⋯</strong> button in the top-right corner of the screen</p>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center text-white text-xs font-bold shrink-0">2</span>
                <p className="text-white text-sm pt-0.5">Tap <strong>"Open in Safari"</strong> from the menu</p>
              </li>
            </ol>
            <button onClick={() => setShowIOSHelp(false)} className="w-full py-3 rounded-2xl bg-white/10 text-white text-sm font-medium hover:bg-white/20 transition-colors">
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

            {/* Logo / Branding */}
            <div className="mb-12 text-center">
              <img
                src={logoSrc}
                alt="USALB RADIO"
                className="w-full max-w-xs mx-auto rounded-xl"
                data-testid="img-logo"
              />
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
              onClick={togglePlay}
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

            {/* Offline / Retry Status */}
            {streamOffline && !isLoading && (
              <div className="mb-8 flex flex-col items-center gap-2 text-center">
                <div className="flex items-center gap-2 text-yellow-500">
                  <WifiOff className="w-4 h-4" />
                  <span className="text-sm font-medium">Stream temporarily offline</span>
                </div>
                {retryCountdown > 0 ? (
                  <p className="text-xs text-gray-500">
                    Retrying in <span className="text-gray-300 font-medium">{retryCountdown}s</span> — or tap above to retry now
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">Tap the button above to retry</p>
                )}
              </div>
            )}
            {!streamOffline && <div className="mb-8" />}

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
                       <span className="text-white font-medium text-sm">Open Messenger</span>
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
        src={FALLBACK_STREAM_URL}
        preload="auto"
        autoPlay
        playsInline
      />
    </div>
  );
}
