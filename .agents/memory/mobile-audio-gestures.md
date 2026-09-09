---
name: Mobile audio gestures
description: Durable guidance for reliable HTML audio playback across mobile browsers and webviews.
---

Mobile browsers may reject audio when a click handler waits for a network request before calling `audio.play()`. Background autoplay attempts can also occupy the player and interfere with a real tap.

**Why:** User-initiated playback requires an active gesture, and that activation can expire across an awaited fetch or be consumed by a competing autoplay attempt.

**How to apply:** Resolve stream URLs ahead of time, avoid automatic play attempts that race with the control, and invoke `audio.play()` synchronously from the tap whenever a cached URL is available. Refresh the URL after genuine stream failures.

Listen2MyRadio can return HTTP 200 with `Content-Length: 1`, `Content-Type: text/html`, and a newline instead of audio while a station is offline or waking up.

**Why:** Treating that placeholder as a stream makes mobile browsers report confusing playback or autoplay errors.

**How to apply:** Validate the upstream content type/body before proxying it, retry briefly, and report the station as unavailable when no audio response arrives.