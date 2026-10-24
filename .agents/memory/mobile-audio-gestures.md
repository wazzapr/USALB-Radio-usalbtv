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

The official Listen2MyRadio player confirms the station listener by POSTing to `openfire.ajax.php` before it starts audio. Loading its whole page in a hidden iframe can navigate the top-level page on some devices.

**Why:** The provider's wake-up step prepares the stream, but the hidden page is not safe to embed as an invisible warm-up.

**How to apply:** Fetch the official page, preserve its session cookie, call the small wake-up endpoint server-side, then proxy the MP3 through the app's own origin.