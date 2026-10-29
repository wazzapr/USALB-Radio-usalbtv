---
name: Mobile audio gestures
description: Durable guidance for reliable HTML audio playback across mobile browsers and webviews.
---

Mobile browsers may reject audio when a click handler waits for a network request before calling `audio.play()`. Start a same-origin stream endpoint synchronously from the user's tap, and let the server resolve the provider URL afterward.

**Why:** User-initiated playback requires an active gesture, and that activation can expire across an awaited fetch or be consumed by a competing autoplay attempt.

**How to apply:** Avoid awaiting URL lookup before `audio.play()`; set a same-origin proxy URL and invoke play synchronously in the tap handler. Refresh the provider URL on the server after genuine stream failures.

Listen2MyRadio can return HTTP 200 with `Content-Length: 1`, `Content-Type: text/html`, and a newline instead of audio while a station is offline or waking up.

**Why:** Treating that placeholder as a stream makes mobile browsers report confusing playback or autoplay errors.

**How to apply:** Validate the upstream content type/body before proxying it, retry briefly, and report the station as unavailable when no audio response arrives.

The official Listen2MyRadio player confirms the listener by POSTing to `openfire.ajax.php`. A hidden provider page can perform this check from the listener's browser, but it must be sandboxed without top-navigation permission so it cannot take over the app.

**Why:** The provider page has attempted to navigate the top-level window when embedded. The sandbox blocks that navigation while preserving the provider's page-load confirmation.

**How to apply:** Load the provider page briefly in a hidden sandboxed iframe, then play its original MP3 URL in the app's audio element. Use a same-origin redirect endpoint to discover the current stream without showing the provider page.

On this app's deployment, a single proxied live MP3 response is terminated after about five minutes even when the provider is still sending audio.

**Why:** Deployment logs showed repeated `/api/stream` requests aborted at roughly 300 seconds, which caused audible dropouts and reconnects independent of the station's state.

**How to apply:** If the provider's MP3 URL plays directly in an audio element, redirect the audio request to that URL so the browser bypasses the proxy and receives the original audio. This app's owner wants the provider's audio unchanged; use HLS transcoding only if direct playback cannot work.