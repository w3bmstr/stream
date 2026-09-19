# Church A/V Live Streaming System

Production-grade A/V suite for churches: multi-camera ingest, live switching, delay buffer, recording, streaming, editing, and uploads.

## Features

✅ Multi-camera ingest (USB, HDMI, RTSP, NDI)
✅ Real-time scene switching with overlays
✅ Adjustable delay buffer (5s–5 min)
✅ ISO + program recording
✅ RTMP/HLS/SRT streaming
✅ Post-service editing (trim, concat, overlay)
✅ YouTube/Facebook upload integration
✅ Automated scheduling
✅ JSON-based config (no database)

## Setup

1. **Install dependencies:**
   ```
   npm install
   ```

2. **Install FFmpeg:**
   - Windows: `choco install ffmpeg` or download from ffmpeg.org
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt-get install ffmpeg`

3. **Run the app:**
   ```
   npm start
   ```
   or double-click `START_APP.bat`. Either way this starts a small local
   server at **http://localhost:8787** and opens it in your browser.

   > **Important:** open the app through that `http://localhost:8787` link,
   > not by double-clicking `index.html` directly. Camera access and the
   > live-streaming feature below both require the local server — a plain
   > `file://` page can't do either reliably.

## What's actually real vs. UI-only

This is an honest status of what currently works end-to-end vs. what is
still a visual mockup for a feature to be wired up later:

- **Real:** local/USB camera preview (`getUserMedia`), IP/security camera
  preview over HTTP MJPEG, local recording to a file (`MediaRecorder`),
  live thumbnail previews for every detected camera, auto-connecting newly
  plugged-in cameras, split-screen/PIP program compositing, and **live RTMP
  streaming** ("Go live" panel) to YouTube, Facebook, or any custom RTMP
  server, via the local server + FFmpeg.
  (Note: an earlier version of this README described the Go Live panel as
  already built when the actual `index.html` didn't yet contain it — that's
  now fixed; the panel and its WebSocket client are really there.)
- **UI-only (not yet implemented):** the hardware-style switcher panel,
  PTZ pan/tilt/zoom controls, NDI/SRT outputs, and the post-service editor
  — these currently just show status text like "(UI only, no camera
  connected)" and don't move real hardware or produce real files yet.

## New: auto-connect + live thumbnails

Every camera Windows/the browser can see now shows up as a small live
thumbnail (not just a text button) under "Program sources." Cameras you
haven't opened yet show a "Connect" button instead of eating bandwidth for
a preview you're not using. When "Auto-connect new cameras" is checked, a
newly plugged-in camera (or phone via DroidCam/Phone Link) opens itself
into a thumbnail automatically — it does **not** auto-cut to Program unless
nothing was live yet.

## New: split-screen / multiview program

Under "Split-screen / multiview program output," pick a layout — side-by-
side, quad, or picture-in-picture — assign already-connected cameras to
each slot, and click **Apply layout**. This composites the chosen live
camera feeds onto a canvas in real time and makes *that* the Program feed,
so it's what gets recorded and streamed, not just a preview-only effect.
Switch back to "Single camera" and click a thumbnail to return to normal
cut/fade switching.

## Going live (RTMP)

The "Go live" panel under the camera preview pushes whatever is currently
on **Program** (laptop/USB camera or IP camera, plus mic audio) to an RTMP
destination:

1. Pick **YouTube**, **Facebook**, or **Custom**.
2. Paste your **stream key** (from YouTube Studio / Facebook Live
   Producer). For Custom, paste the full `rtmp://` or `rtmps://` URL
   instead.
3. Pick a quality (480p/720p/1080p — this sets both resolution and
   bitrate).
4. Click **Go live**. Click **Stop** to end the stream.

Under the hood: the browser draws whatever's on Program onto a hidden
canvas, captures that as a `MediaStream`, records it to WebM with
`MediaRecorder`, and streams the chunks over a WebSocket to `server.js`,
which pipes them into FFmpeg (`-f webm -i pipe:0 ... -f flv <rtmp url>`).

Notes and limits:
- This needs a reasonably fast upload connection (2.5 Mbps+ for 720p).
- The browser tab must stay open and the computer must stay awake —
  closing the tab or sleeping the laptop stops the stream.
- If FFmpeg isn't installed or isn't on PATH, you'll see an error in the
  live status line; set the `FFMPEG_PATH` environment variable to its
  full path if it's installed somewhere non-standard.
- Nothing about this exposes your camera to the internet by itself —
  the only outbound connection is the one you explicitly start to your
  chosen RTMP destination (YouTube/Facebook/etc.), and only for as long
  as "Go live" is active.

## Project Structure

```
app/
├── main/                 # Node.js backend
│   ├── core/            # Business logic modules
│   ├── ffmpeg/          # FFmpeg pipelines
│   ├── storage/         # JSON config files
│   └── utils/           # Helpers
├── renderer/            # React frontend
│   ├── components/      # UI components
│   ├── pages/           # Full pages
│   ├── hooks/           # React hooks
│   └── styles/          # CSS
recordings/             # Program recordings
iso/                    # ISO camera recordings
uploads/                # Exported videos
logs/                   # System logs
```

## Configuration

Edit JSON files in `app/main/storage/`:
- `config.json` — FFmpeg path, theme, defaults
- `cameras.json` — Camera definitions
- `audio.json` — Audio settings
- `scenes.json` — Scene definitions with filter graphs
- `overlays.json` — Text overlays
- `schedules.json` — Automated tasks

## API (IPC Channels)

### Cameras
- `cameras:list` — Get all cameras
- `cameras:start` → config — Start capturing
- `cameras:stop` — Stop capturing

### Streaming
- `stream:start` → { type, url } — Start streaming (RTMP/HLS/SRT)
- `stream:stop` — Stop streaming

### Recording
- `record:start` — Start recording
- `record:stop` — Stop recording

### Delay Buffer
- `delay:set` → seconds — Set delay
- `delay:dump` — Dump last 10 seconds
- `delay:freeze` — Freeze output

### Editor
- `editor:trim` → { input, output, start, duration } — Trim video
- `editor:export` → { type, files, overlay, output } — Export

### Uploads
- `upload:youtube` → { file, title } — Upload to YouTube
- `upload:facebook` → { file, title } — Upload to Facebook

## Requirements

- **Node.js 16+**
- **FFmpeg** (with libx264 encoder)
- **Windows/macOS/Linux** (Electron supports all)

## Troubleshooting

**"FFmpeg not found"**
- Ensure FFmpeg is installed and in PATH
- Edit `app/main/storage/config.json` and set `ffmpegPath` to full path

**"Port already in use"**
- Change UDP ports in `app/main/core/` modules (default: 5001–5003, 6000, 7000)

**"Camera not detected"**
- Check camera type and device name in `cameras.json`
- Test with `ffmpeg -list_devices true -f dshow -i dummy` (Windows)

## License

MIT

---

## Production hardening (what changed for reliability)

A few things were added specifically so this holds up during a real, live
service instead of just a demo:

- **Closing the tab warns you** if a recording or a live stream is running,
  so an accidental click doesn't silently kill your footage or your stream.
- **Camera disconnect detection**: if a camera on Program is unplugged or
  loses signal mid-service, you get an explicit on-screen warning instead of
  a frozen picture with no explanation.
- **Go Live auto-reconnects**: if the connection to the local server drops
  unexpectedly (Wi-Fi hiccup, brief network blip), it retries automatically
  (up to 5 times, with backoff) instead of silently going dark. A genuine
  configuration error (bad stream key, FFmpeg missing) does *not* auto-retry
  — those need you to fix the setting and click Go live again.
- **IP camera proxy fetches any URL it's given** (not restricted to your
  local network) — this makes it flexible enough to pull in a remote/cloud
  camera, not just ones on your LAN. Be aware this also means anyone who can
  reach this server can make it fetch arbitrary internet addresses through
  it (an "open proxy"), which matters if this computer is ever reachable
  from outside your building. To restrict it back to local/private network
  addresses only, start the server with `IPCAM_PROXY_RESTRICT_LOCAL=1` set
  as an environment variable.
- **Graceful server shutdown**: stopping `server.js` (Ctrl+C) now cleanly
  kills any FFmpeg process it started, instead of leaving one running in the
  background.
- The server now prints a **network address** (e.g. `http://192.168.1.x:8787`)
  on startup, not just `localhost` — useful if you want to open the same
  control panel from a second computer/tablet on the same network.

## Pre-service checklist

- [ ] Run through Video Inputs: every camera you plan to use shows a live
      thumbnail under "Program sources."
- [ ] Test CUT, AUTO, and the T-bar on the Switching tab with your real cameras.
- [ ] If you use split-screen, apply the layout once and confirm all slots show video.
- [ ] Start a short test recording and confirm the file downloads and plays.
- [ ] Go Live with your real stream key at least once before the service,
      and confirm the platform (YouTube/Facebook) actually shows video.
- [ ] Check audio: monitor mic is unmuted, EQ/mixer levels look reasonable.
- [ ] If anything is on Wi-Fi (IP cameras, a laptop feeding the room), confirm
      signal strength is solid — Go Live's auto-reconnect helps with blips,
      but won't save a truly dead connection.

---

Built with ❤️ for churches worldwide.