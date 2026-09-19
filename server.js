// server.js — Church A/V Suite local helper server
//
// Serves index.html and friends, and provides one real live-streaming
// feature: a WebSocket endpoint (/live) that receives WebM video chunks
// recorded in the browser (from whatever is on Program) and pipes them
// into FFmpeg, which re-encodes and pushes them out as RTMP to YouTube,
// Facebook, or any other RTMP ingest.
//
// Requirements: Node.js 16+, and FFmpeg installed and on PATH (or set
// FFMPEG_PATH to the full path to ffmpeg.exe).
//
// Run with:  npm install   then   npm start
// Then open: http://localhost:8787   (do NOT open index.html directly —
// getUserMedia + the /live WebSocket both need this server running).

const path = require("path");
const http = require("http");
const https = require("https");
const dns = require("dns");
const os = require("os");
const net = require("net");
const express = require("express");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 8787;
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const activeFfmpegProcs = new Set(); // tracked so we can clean them up on shutdown

const app = express();
app.use(express.static(__dirname));

// ---------- IP camera proxy ----------
// Fetches an MJPEG/snapshot stream from a camera and re-serves it from this
// same-origin server. This lets the browser draw the feed onto a <canvas>
// (for split-screen / recording / streaming) without hitting cross-origin
// "tainted canvas" restrictions that most consumer cameras would otherwise
// trigger (they don't send CORS headers).
//
// SECURITY NOTE: by default this fetches ANY http(s) URL it's given, with no
// restriction to your local network. That makes it more flexible (works with
// remote/cloud cameras, not just ones on your LAN) but it also means anyone
// who can reach this server can make it fetch arbitrary internet addresses
// on your behalf — a classic "open proxy." That's a real risk if this
// computer is ever reachable from outside your building (e.g. port-forwarded).
// To restore the local-network-only restriction, set the environment
// variable IPCAM_PROXY_RESTRICT_LOCAL=1 before starting the server.
const RESTRICT_IPCAM_PROXY = process.env.IPCAM_PROXY_RESTRICT_LOCAL === "1";

function ipToLong(ip) {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}
function isPrivateIPv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const long = ipToLong(ip);
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (long & mask) === (ipToLong(base) & mask);
  };
  return inRange("10.0.0.0", 8) || inRange("172.16.0.0", 12) || inRange("192.168.0.0", 16) ||
         inRange("127.0.0.0", 8) || inRange("169.254.0.0", 16);
}
function isPrivateAddress(addr) {
  if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
  if (net.isIPv6(addr)) return /^fe80:/i.test(addr) || /^fc/i.test(addr) || /^fd/i.test(addr);
  return isPrivateIPv4(addr);
}

app.get("/ipcam-proxy", (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    res.status(400).send("Missing or invalid url parameter.");
    return;
  }
  let parsed;
  try { parsed = new URL(target); } catch (_) {
    res.status(400).send("Invalid url.");
    return;
  }

  const fetchIt = () => {
    const lib = parsed.protocol === "https:" ? https : http;
    const upstreamReq = lib.get(target, { timeout: 8000 }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 200, {
        "Content-Type": upstreamRes.headers["content-type"] || "multipart/x-mixed-replace",
        "Cache-Control": "no-store"
      });
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.end());
    });
    upstreamReq.on("timeout", () => upstreamReq.destroy());
    upstreamReq.on("error", (e) => {
      if (!res.headersSent) res.status(502).send("Could not reach camera: " + e.message);
      else res.end();
    });
    req.on("close", () => upstreamReq.destroy());
  };

  if (!RESTRICT_IPCAM_PROXY) {
    fetchIt();
    return;
  }
  dns.lookup(parsed.hostname, (err, address) => {
    if (err || !address || !isPrivateAddress(address)) {
      res.status(403).send("This proxy only fetches cameras on your local/private network.");
      return;
    }
    fetchIt();
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/live" });

function isValidRtmpUrl(url) {
  return typeof url === "string" && /^rtmps?:\/\/[^\s]+$/i.test(url);
}

wss.on("connection", (ws) => {
  let ffmpeg = null;

  function killFfmpeg() {
    if (!ffmpeg) return;
    const proc = ffmpeg;
    ffmpeg = null;
    try { proc.stdin.end(); } catch (_) {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} }, 1500);
  }

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }

      if (msg.type === "start") {
        killFfmpeg();

        if (!isValidRtmpUrl(msg.rtmpUrl)) {
          ws.send(JSON.stringify({ type: "error", message: "Missing or invalid RTMP URL / stream key." }));
          return;
        }

        const bitrate = Math.max(400, Math.min(8000, msg.bitrateKbps || 2500));
        const fps = Math.max(15, Math.min(60, msg.fps || 30));

        const args = [
          "-loglevel", "warning",
          "-f", "webm", "-i", "pipe:0",
          "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
          "-pix_fmt", "yuv420p",
          "-b:v", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`,
          "-g", String(fps * 2), "-r", String(fps),
          "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
          "-f", "flv", msg.rtmpUrl
        ];

        try {
          ffmpeg = spawn(FFMPEG_PATH, args);
          activeFfmpegProcs.add(ffmpeg);
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: "Could not launch FFmpeg: " + err.message }));
          return;
        }

        ffmpeg.on("error", (err) => {
          ws.send(JSON.stringify({
            type: "error",
            message: "FFmpeg failed to start (" + err.message + "). Is FFmpeg installed and in PATH, or FFMPEG_PATH set?"
          }));
        });

        ffmpeg.stderr.on("data", (chunk) => {
          // FFmpeg logs progress/errors to stderr; forward a trimmed tail so
          // the browser can show useful diagnostics if something goes wrong.
          const line = chunk.toString().trim();
          if (line) ws.send(JSON.stringify({ type: "log", message: line.slice(-500) }));
        });

        ffmpeg.on("exit", (code, signal) => {
          activeFfmpegProcs.delete(ffmpeg);
          if (ffmpeg) {
            ws.send(JSON.stringify({ type: "ended", code, signal }));
          }
          ffmpeg = null;
        });

        ws.send(JSON.stringify({ type: "started" }));

      } else if (msg.type === "stop") {
        killFfmpeg();
      }
      return;
    }

    // Binary WebSocket message = a chunk of WebM video from MediaRecorder.
    if (ffmpeg && ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(Buffer.from(data));
    }
  });

  ws.on("close", killFfmpeg);
  ws.on("error", killFfmpeg);
});

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`Church A/V Suite running at http://localhost:${PORT}`);
  getLanAddresses().forEach(addr => {
    console.log(`  Also reachable on your network at: http://${addr}:${PORT}`);
  });
  console.log(`(Live RTMP push needs FFmpeg on PATH; set FFMPEG_PATH env var if it's somewhere else.)`);
});

// Graceful shutdown: make sure no orphaned FFmpeg processes keep running
// (and keep pushing a frozen stream) after this server exits.
function shutdown() {
  console.log("\nShutting down — stopping any active FFmpeg streams…");
  activeFfmpegProcs.forEach(proc => { try { proc.kill("SIGKILL"); } catch (_) {} });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000); // don't hang if something's stuck
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
