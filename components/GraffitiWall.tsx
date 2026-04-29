"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from "react";
import { io, type Socket } from "socket.io-client";
import {
  WALL_SIZE,
  clamp,
  generateId,
  type Point,
  type Stroke,
  type WallStats,
  type WallTool
} from "@/lib/wall";

type GraffitiWallProps = {
  className?: string;
  color: string;
  interactive?: boolean;
  onConnectionChange?: (connected: boolean) => void;
  onStatsChange?: (stats: WallStats) => void;
  size: number;
  tool: WallTool;
  userId: string;
  variant?: "draw" | "display" | "admin";
};

export type GraffitiWallHandle = {
  reset: (pin?: string) => Promise<boolean>;
  undo: () => void;
};

type InitPayload = {
  strokes: Stroke[];
};

// --- Brick texture ---

const BRICK_SIZE = { width: 216, height: 96 } as const;
const MORTAR_WIDTH = 0;

const BRICK_PALETTE: [number, number, number][] = [
  [182, 60, 40], [168, 50, 34], [195, 70, 46], [158, 46, 32],
  [188, 64, 42], [172, 54, 36], [202, 76, 50], [162, 52, 36],
  [175, 57, 39], [190, 67, 44], [155, 44, 30], [178, 58, 38],
];

function drawBaseBricks(ctx: CanvasRenderingContext2D) {
  const W = WALL_SIZE.width;
  const H = WALL_SIZE.height;
  const BW = BRICK_SIZE.width;
  const BH = BRICK_SIZE.height;
  const MW = MORTAR_WIDTH;

  ctx.fillStyle = "#9a8878";
  ctx.fillRect(0, 0, W, H);

  const rowCount = Math.ceil(H / BH) + 1;
  const colCount = Math.ceil(W / BW) + 2;

  for (let row = 0; row < rowCount; row++) {
    const offset = (row % 2) * (BW / 2);
    for (let col = 0; col < colCount; col++) {
      const bx = col * BW - offset + MW / 2;
      const by = row * BH + MW / 2;
      const bw = BW - MW;
      const bh = BH - MW;
      if (bx + bw < 0 || bx > W || by + bh < 0 || by > H) continue;

      const hash = (row * 2531011 + col * 214013 + 1) >>> 0;
      const [pr, pg, pb] = BRICK_PALETTE[hash % BRICK_PALETTE.length];
      const variance = ((hash >> 8) & 0x1f) - 12;

      ctx.fillStyle = `rgb(${Math.min(255, Math.max(0, pr + variance))},${Math.min(255, Math.max(0, pg + Math.round(variance * 0.5)))},${Math.min(255, Math.max(0, pb + Math.round(variance * 0.3)))})`;
      ctx.fillRect(bx, by, bw, bh);
    }
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${src}`));
    img.src = src;
  });
}

// Draws grayscale lighting from normal map onto a separate canvas.
// Applied above all content via mix-blend-mode: multiply —
// so paint AND bricks both get normal-map surface shading.
function drawLightingCanvas(canvas: HTMLCanvasElement, nmImg: HTMLImageElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = WALL_SIZE.width;
  const H = WALL_SIZE.height;

  const nmCanvas = document.createElement("canvas");
  nmCanvas.width = nmImg.naturalWidth;
  nmCanvas.height = nmImg.naturalHeight;
  const nmCtx = nmCanvas.getContext("2d")!;
  nmCtx.drawImage(nmImg, 0, 0);
  const nmData = nmCtx.getImageData(0, 0, nmCanvas.width, nmCanvas.height).data;
  const nmW = nmCanvas.width;
  const nmH = nmCanvas.height;

  // Light from upper-left at ~45° (normalized)
  const lx = -0.42;
  const ly = -0.42;
  const lz = 0.80;

  // Keep ambient high so multiply doesn't darken too aggressively
  const ambient = 0.72;
  const diffuseStr = 0.28;

  const imgData = ctx.createImageData(W, H);
  const data = imgData.data;

  for (let py = 0; py < H; py++) {
    // 2x tiling: scale py by 2 before modulo
    const nmRowBase = ((py * 2) % nmH) * nmW;
    const rowBase = py * W;
    for (let px = 0; px < W; px++) {
      const bi = (rowBase + px) << 2;
      // 2x tiling: scale px by 2 before modulo
      const ni = (nmRowBase + ((px * 2) % nmW)) << 2;

      // RGB → surface normal (OpenGL convention)
      const nx = (nmData[ni]     - 128) * 0.0078125;
      const ny = (nmData[ni + 1] - 128) * 0.0078125;
      const nz =  nmData[ni + 2]        * 0.00392157;

      const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
      const v = ((ambient + diffuseStr * diffuse) * 255) | 0;

      data[bi]     = v;
      data[bi + 1] = v;
      data[bi + 2] = v;
      data[bi + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

// --- Drawing helpers ---

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getCanvasContext(canvas: HTMLCanvasElement | null) {
  return canvas?.getContext("2d") ?? null;
}

function configureStroke(context: CanvasRenderingContext2D, stroke: Stroke) {
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = stroke.size;
  context.globalCompositeOperation =
    stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
}

function drawDot(context: CanvasRenderingContext2D, stroke: Stroke, point: Point) {
  context.save();
  configureStroke(context, stroke);
  context.beginPath();
  context.arc(point.x, point.y, stroke.size / 2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawSegment(
  context: CanvasRenderingContext2D,
  stroke: Stroke,
  from: Point,
  points: Point[]
) {
  if (!points.length) return;
  context.save();
  configureStroke(context, stroke);
  context.beginPath();
  context.moveTo(from.x, from.y);
  for (const point of points) context.lineTo(point.x, point.y);
  context.stroke();
  context.restore();
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke) {
  if (!stroke.points.length) return;
  if (stroke.points.length === 1) {
    drawDot(context, stroke, stroke.points[0]);
    return;
  }
  drawSegment(context, stroke, stroke.points[0], stroke.points.slice(1));
}

// --- Component ---

export const GraffitiWall = forwardRef<GraffitiWallHandle, GraffitiWallProps>(
  function GraffitiWall(
    {
      className = "",
      color,
      interactive = false,
      onConnectionChange,
      onStatsChange,
      size,
      tool,
      userId,
      variant = "draw"
    },
    ref
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const brickCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const lightingCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const socketRef = useRef<Socket | null>(null);
    const strokesRef = useRef<Stroke[]>([]);
    const activeRemoteRef = useRef<Map<string, Stroke>>(new Map());
    const activeLocalRef = useRef<Stroke | null>(null);
    const pointerIdRef = useRef<number | null>(null);
    const [connected, setConnected] = useState(false);
    const [stats, setStats] = useState<WallStats>({
      onlineCount: 0,
      strokeCount: 0
    });

    const redraw = useCallback(() => {
      const context = getCanvasContext(canvasRef.current);
      if (!context) return;
      context.clearRect(0, 0, WALL_SIZE.width, WALL_SIZE.height);
      for (const stroke of strokesRef.current) drawStroke(context, stroke);
    }, []);

    // Draw brick base immediately; apply normal-map lighting after image loads
    useEffect(() => {
      const brickCanvas = brickCanvasRef.current;
      const lightingCanvas = lightingCanvasRef.current;
      if (!brickCanvas || !lightingCanvas) return;

      const ctx = brickCanvas.getContext("2d");
      if (ctx) drawBaseBricks(ctx);

      loadImage("/GreenBricks_N.jpg")
        .then((img) => drawLightingCanvas(lightingCanvas, img))
        .catch(() => {});
    }, []);

    useEffect(() => {
      onConnectionChange?.(connected);
    }, [connected, onConnectionChange]);

    useEffect(() => {
      onStatsChange?.(stats);
    }, [onStatsChange, stats]);

    useEffect(() => {
      const socket = io({
        path: "/socket.io",
        transports: ["websocket", "polling"]
      });
      socketRef.current = socket;

      socket.on("connect", () => setConnected(true));
      socket.on("disconnect", () => setConnected(false));

      socket.on("wall:init", (payload: InitPayload) => {
        strokesRef.current = payload.strokes || [];
        activeRemoteRef.current.clear();
        requestAnimationFrame(redraw);
      });

      socket.on("wall:replace", (payload: InitPayload) => {
        strokesRef.current = payload.strokes || [];
        activeRemoteRef.current.clear();
        requestAnimationFrame(redraw);
      });

      socket.on("wall:stats", (payload: WallStats) => {
        setStats({
          onlineCount: payload.onlineCount || 0,
          strokeCount: payload.strokeCount || 0
        });
      });

      socket.on("stroke:begin", (stroke: Stroke) => {
        activeRemoteRef.current.set(stroke.id, stroke);
        const context = getCanvasContext(canvasRef.current);
        if (context) drawStroke(context, stroke);
      });

      socket.on("stroke:append", (payload: { id: string; points: Point[] }) => {
        const stroke = activeRemoteRef.current.get(payload.id);
        const context = getCanvasContext(canvasRef.current);
        if (!stroke || !context || !payload.points?.length) return;
        const previousPoint = stroke.points[stroke.points.length - 1];
        stroke.points.push(...payload.points);
        drawSegment(context, stroke, previousPoint, payload.points);
      });

      socket.on("stroke:end", (payload: { id: string }) => {
        const stroke = activeRemoteRef.current.get(payload.id);
        if (!stroke) return;
        activeRemoteRef.current.delete(payload.id);
        strokesRef.current = [...strokesRef.current, stroke];
      });

      socket.on("stroke:removed", (payload: { id: string }) => {
        strokesRef.current = strokesRef.current.filter((s) => s.id !== payload.id);
        requestAnimationFrame(redraw);
      });

      return () => {
        socket.disconnect();
        socketRef.current = null;
      };
    }, [redraw]);

    useImperativeHandle(
      ref,
      () => ({
        reset(pin = "") {
          return new Promise((resolve) => {
            const socket = socketRef.current;
            if (!socket) { resolve(false); return; }
            const timer = window.setTimeout(() => resolve(false), 4000);
            socket.emit("wall:reset", { pin }, (response: { ok?: boolean }) => {
              window.clearTimeout(timer);
              resolve(Boolean(response?.ok));
            });
          });
        },
        undo() {
          const socket = socketRef.current;
          if (!socket) return;
          socket.emit("stroke:undo", { userId }, (response: { ok?: boolean; id?: string }) => {
            if (response?.ok && response.id) {
              strokesRef.current = strokesRef.current.filter((s) => s.id !== response.id);
              requestAnimationFrame(redraw);
            }
          });
        }
      })
    );

    const getWallPoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return {
        x: clamp(((event.clientX - rect.left) / rect.width) * WALL_SIZE.width, 0, WALL_SIZE.width),
        y: clamp(((event.clientY - rect.top) / rect.height) * WALL_SIZE.height, 0, WALL_SIZE.height)
      };
    }, []);

    const beginStroke = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!interactive || event.button !== 0) return;
        const point = getWallPoint(event);
        const stroke: Stroke = {
          id: `${userId}-${generateId()}`,
          userId, tool, color, size,
          points: [point],
          createdAt: Date.now()
        };
        pointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        activeLocalRef.current = stroke;
        const context = getCanvasContext(canvasRef.current);
        if (context) drawStroke(context, stroke);
        socketRef.current?.emit("stroke:begin", { ...stroke, point });
      },
      [color, getWallPoint, interactive, size, tool, userId]
    );

    const appendStroke = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        const stroke = activeLocalRef.current;
        if (!stroke || pointerIdRef.current !== event.pointerId) return;
        const point = getWallPoint(event);
        const previousPoint = stroke.points[stroke.points.length - 1];
        if (distance(previousPoint, point) < 1.5) return;
        stroke.points.push(point);
        const context = getCanvasContext(canvasRef.current);
        if (context) drawSegment(context, stroke, previousPoint, [point]);
        socketRef.current?.emit("stroke:append", { id: stroke.id, points: [point] });
      },
      [getWallPoint]
    );

    const finishStroke = useCallback(
      (event: React.PointerEvent<HTMLCanvasElement>) => {
        const stroke = activeLocalRef.current;
        if (!stroke || pointerIdRef.current !== event.pointerId) return;
        strokesRef.current = [...strokesRef.current, stroke];
        activeLocalRef.current = null;
        pointerIdRef.current = null;
        socketRef.current?.emit("stroke:end", { id: stroke.id });
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      },
      []
    );

    return (
      <div className={`wall-stage wall-stage-${variant} ${className}`}>
        <div className="wall-surface" data-connected={connected}>
          <canvas
            ref={brickCanvasRef}
            className="brick-canvas"
            width={WALL_SIZE.width}
            height={WALL_SIZE.height}
            aria-hidden="true"
          />
          <canvas
            ref={canvasRef}
            className="spray-canvas"
            width={WALL_SIZE.width}
            height={WALL_SIZE.height}
            aria-label="Shared graffiti wall"
            onPointerCancel={finishStroke}
            onPointerDown={beginStroke}
            onPointerMove={appendStroke}
            onPointerUp={finishStroke}
          />
          <canvas
            ref={lightingCanvasRef}
            className="lighting-canvas"
            width={WALL_SIZE.width}
            height={WALL_SIZE.height}
            aria-hidden="true"
          />
        </div>
      </div>
    );
  }
);
