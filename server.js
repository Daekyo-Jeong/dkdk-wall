const fs = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const next = require("next");
const { loadEnvConfig } = require("@next/env");
const { Server } = require("socket.io");

loadEnvConfig(process.cwd());

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT || "3000", 10);
const hostname = process.env.HOST || "0.0.0.0";

const WALL_SIZE = { width: 4320, height: 1920 };
const MAX_STROKES = 20000;
const MAX_POINTS_PER_STROKE = 6000;
const MIN_SIZE = 2;
const MAX_SIZE = 96;
const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "wall-state.json");
const ADMIN_PIN = process.env.ADMIN_PIN || "";
const USE_HTTPS = process.env.USE_HTTPS === "1";
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || "";
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

let strokes = [];
const activeStrokes = new Map();
const activeAirStrokes = new Map();
let persistTimer = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sanitizePoint(point) {
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
    return null;
  }

  return {
    x: clamp(point.x, 0, WALL_SIZE.width),
    y: clamp(point.y, 0, WALL_SIZE.height)
  };
}

function sanitizeColor(color) {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)
    ? color
    : "#f8fafc";
}

function sanitizeStrokeStart(payload) {
  const firstPoint = sanitizePoint(payload?.point);
  if (!payload || !firstPoint) {
    return null;
  }

  const id = typeof payload.id === "string" ? payload.id.slice(0, 80) : "";
  const userId =
    typeof payload.userId === "string" ? payload.userId.slice(0, 80) : "";
  const tool = payload.tool === "eraser" ? "eraser" : "brush";

  if (!id || !userId) {
    return null;
  }

  return {
    id,
    userId,
    tool,
    color: sanitizeColor(payload.color),
    size: clamp(Number(payload.size) || 14, MIN_SIZE, MAX_SIZE),
    points: [firstPoint],
    createdAt: Date.now()
  };
}

function sanitizePointBatch(points) {
  if (!Array.isArray(points)) {
    return [];
  }

  return points.map(sanitizePoint).filter(Boolean).slice(0, 64);
}

function sanitizeAirUpdate(payload) {
  if (!payload || typeof payload.userId !== "string") {
    return null;
  }

  const point = sanitizePoint(payload.point);
  if (!point) {
    return null;
  }

  return {
    userId: payload.userId.slice(0, 80),
    point,
    spraying: Boolean(payload.spraying),
    tool: payload.tool === "eraser" ? "eraser" : "brush",
    color: sanitizeColor(payload.color),
    size: clamp(Number(payload.size) || 14, MIN_SIZE, MAX_SIZE)
  };
}

async function loadState() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    strokes = Array.isArray(parsed.strokes) ? parsed.strokes.slice(-MAX_STROKES) : [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load wall state:", error);
    }
    strokes = [];
  }
}

async function persistState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(
    tmpFile,
    JSON.stringify({ wallSize: WALL_SIZE, strokes: strokes.slice(-MAX_STROKES) }),
    "utf8"
  );
  await fs.rename(tmpFile, DATA_FILE);
}

function schedulePersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistState().catch((error) => {
      console.error("Failed to persist wall state:", error);
    });
  }, 350);
}

function isAdmin(pin) {
  return !ADMIN_PIN || pin === ADMIN_PIN;
}

function getStats(io) {
  return {
    strokeCount: strokes.length,
    onlineCount: io.engine.clientsCount
  };
}

async function start() {
  await loadState();
  await app.prepare();

  const requestHandler = (req, res) => {
    handle(req, res);
  };

  let server;
  let protocol = "http";
  if (USE_HTTPS) {
    if (!SSL_KEY_PATH || !SSL_CERT_PATH) {
      throw new Error(
        "USE_HTTPS=1 requires SSL_KEY_PATH and SSL_CERT_PATH in environment variables"
      );
    }
    const [key, cert] = await Promise.all([
      fs.readFile(path.resolve(process.cwd(), SSL_KEY_PATH)),
      fs.readFile(path.resolve(process.cwd(), SSL_CERT_PATH))
    ]);
    server = https.createServer({ key, cert }, requestHandler);
    protocol = "https";
  } else {
    server = http.createServer(requestHandler);
  }

  const io = new Server(server, {
    path: "/socket.io",
    cors: {
      origin: "*"
    }
  });

  function broadcastStats() {
    io.emit("wall:stats", getStats(io));
  }

  io.on("connection", (socket) => {
    socket.emit("wall:init", {
      wallSize: WALL_SIZE,
      strokes,
      adminLocked: Boolean(ADMIN_PIN)
    });
    broadcastStats();

    socket.on("stroke:begin", (payload, ack) => {
      const stroke = sanitizeStrokeStart(payload);
      if (!stroke) {
        ack?.({ ok: false });
        return;
      }

      activeStrokes.set(stroke.id, { ...stroke, socketId: socket.id });
      socket.broadcast.emit("stroke:begin", stroke);
      ack?.({ ok: true });
    });

    socket.on("stroke:append", (payload) => {
      const id = typeof payload?.id === "string" ? payload.id.slice(0, 80) : "";
      const stroke = activeStrokes.get(id);
      if (!stroke) {
        return;
      }

      const points = sanitizePointBatch(payload.points);
      if (!points.length) {
        return;
      }

      const roomLeft = MAX_POINTS_PER_STROKE - stroke.points.length;
      const nextPoints = points.slice(0, Math.max(0, roomLeft));
      stroke.points.push(...nextPoints);
      if (nextPoints.length) {
        socket.broadcast.emit("stroke:append", { id, points: nextPoints });
      }
    });

    socket.on("stroke:end", (payload, ack) => {
      const id = typeof payload?.id === "string" ? payload.id.slice(0, 80) : "";
      const stroke = activeStrokes.get(id);
      if (!stroke) {
        ack?.({ ok: false });
        return;
      }

      activeStrokes.delete(id);

      if (stroke.points.length > 0) {
        const savedStroke = {
          id: stroke.id,
          userId: stroke.userId,
          tool: stroke.tool,
          color: stroke.color,
          size: stroke.size,
          points: stroke.points,
          createdAt: stroke.createdAt
        };
        strokes.push(savedStroke);
        strokes = strokes.slice(-MAX_STROKES);
        schedulePersist();
        broadcastStats();
      }

      socket.broadcast.emit("stroke:end", { id });
      ack?.({ ok: true });
    });

    socket.on("stroke:undo", (payload, ack) => {
      const userId =
        typeof payload?.userId === "string" ? payload.userId.slice(0, 80) : "";
      if (!userId) {
        ack?.({ ok: false });
        return;
      }

      const index = strokes.findLastIndex((stroke) => stroke.userId === userId);
      if (index === -1) {
        ack?.({ ok: false });
        return;
      }

      const [removed] = strokes.splice(index, 1);
      schedulePersist();
      socket.broadcast.emit("stroke:removed", { id: removed.id });
      broadcastStats();
      ack?.({ ok: true, id: removed.id });
    });

    socket.on("wall:reset", (payload, ack) => {
      if (!isAdmin(payload?.pin || "")) {
        ack?.({ ok: false, error: "invalid_pin" });
        return;
      }

      strokes = [];
      activeStrokes.clear();
      schedulePersist();
      io.emit("wall:replace", { strokes });
      broadcastStats();
      ack?.({ ok: true });
    });

    socket.on("air:update", (payload, ack) => {
      const update = sanitizeAirUpdate(payload);
      if (!update || !update.userId) {
        ack?.({ ok: false });
        return;
      }

      const activeId = activeAirStrokes.get(socket.id);

      if (!update.spraying) {
        if (activeId) {
          const stroke = activeStrokes.get(activeId);
          activeStrokes.delete(activeId);
          activeAirStrokes.delete(socket.id);
          if (stroke && stroke.points.length > 0) {
            strokes.push({
              id: stroke.id,
              userId: stroke.userId,
              tool: stroke.tool,
              color: stroke.color,
              size: stroke.size,
              points: stroke.points,
              createdAt: stroke.createdAt
            });
            strokes = strokes.slice(-MAX_STROKES);
            schedulePersist();
            broadcastStats();
          }
          socket.broadcast.emit("stroke:end", { id: activeId });
        }
        ack?.({ ok: true });
        return;
      }

      if (!activeId) {
        const strokeId = `${update.userId}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 9)}`;
        const stroke = {
          id: strokeId,
          userId: update.userId,
          tool: update.tool,
          color: update.color,
          size: update.size,
          points: [update.point],
          createdAt: Date.now(),
          socketId: socket.id
        };
        activeStrokes.set(strokeId, stroke);
        activeAirStrokes.set(socket.id, strokeId);
        socket.broadcast.emit("stroke:begin", {
          id: stroke.id,
          userId: stroke.userId,
          tool: stroke.tool,
          color: stroke.color,
          size: stroke.size,
          points: stroke.points,
          createdAt: stroke.createdAt
        });
        ack?.({ ok: true });
        return;
      }

      const stroke = activeStrokes.get(activeId);
      if (!stroke) {
        activeAirStrokes.delete(socket.id);
        ack?.({ ok: false });
        return;
      }

      if (stroke.points.length >= MAX_POINTS_PER_STROKE) {
        ack?.({ ok: true });
        return;
      }

      const lastPoint = stroke.points[stroke.points.length - 1];
      const dx = update.point.x - lastPoint.x;
      const dy = update.point.y - lastPoint.y;
      if (dx * dx + dy * dy < 1) {
        ack?.({ ok: true });
        return;
      }

      stroke.points.push(update.point);
      socket.broadcast.emit("stroke:append", { id: activeId, points: [update.point] });
      ack?.({ ok: true });
    });

    socket.on("disconnect", () => {
      const activeId = activeAirStrokes.get(socket.id);
      if (activeId) {
        const stroke = activeStrokes.get(activeId);
        activeAirStrokes.delete(socket.id);
        activeStrokes.delete(activeId);
        if (stroke && stroke.points.length > 0) {
          strokes.push({
            id: stroke.id,
            userId: stroke.userId,
            tool: stroke.tool,
            color: stroke.color,
            size: stroke.size,
            points: stroke.points,
            createdAt: stroke.createdAt
          });
          strokes = strokes.slice(-MAX_STROKES);
          schedulePersist();
          socket.broadcast.emit("stroke:end", { id: activeId });
          broadcastStats();
        }
      }

      for (const [id, stroke] of activeStrokes.entries()) {
        if (stroke.socketId === socket.id) {
          activeStrokes.delete(id);
        }
      }
      broadcastStats();
    });
  });

  server.listen(port, hostname, () => {
    console.log(`Wall server ready: ${protocol}://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
