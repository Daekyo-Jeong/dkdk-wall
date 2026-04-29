"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Brush, Eraser, Smartphone, Undo2, Waves } from "lucide-react";
import { clamp, DEFAULT_COLORS, WALL_SIZE, generateId, type WallTool } from "@/lib/wall";

type AimPoint = { x: number; y: number };

const SEND_INTERVAL_MS = 33;
const AIR_PITCH_RANGE = 35;
const AIR_YAW_RANGE = 45;
const AIR_SMOOTHING = 0.2;
const CENTER_POINT: AimPoint = { x: WALL_SIZE.width / 2, y: WALL_SIZE.height / 2 };

function getOrCreateAirUserId() {
  const saved = window.localStorage.getItem("wall-air-user-id");
  if (saved) return saved;
  const next = `air-${generateId()}`;
  window.localStorage.setItem("wall-air-user-id", next);
  return next;
}

export function AirController() {
  const socketRef = useRef<Socket | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pointRef = useRef<AimPoint>(CENTER_POINT);
  const orientationZeroRef = useRef<{ beta: number; gamma: number } | null>(null);

  const [connected, setConnected] = useState(false);
  const [tool, setTool] = useState<WallTool>("brush");
  const [color, setColor] = useState(DEFAULT_COLORS[0]);
  const [size, setSize] = useState(20);
  const [mode, setMode] = useState<"touch" | "air">("touch");
  const [userId] = useState(() =>
    typeof window === "undefined" ? "loading" : getOrCreateAirUserId()
  );
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [motionStatus, setMotionStatus] = useState("Motion off");
  const [aimPoint, setAimPoint] = useState<AimPoint>(CENTER_POINT);
  const [spraying, setSpraying] = useState(false);

  const indicatorStyle = useMemo(
    () => ({
      left: `${(aimPoint.x / WALL_SIZE.width) * 100}%`,
      top: `${(aimPoint.y / WALL_SIZE.height) * 100}%`,
      borderColor: color,
      boxShadow: `0 0 0 5px ${color}30`
    }),
    [aimPoint.x, aimPoint.y, color]
  );

  useEffect(() => {
    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const send = () => {
      const socket = socketRef.current;
      if (!socket || userId === "loading") return;
      socket.emit("air:update", { userId, point: pointRef.current, spraying, tool, color, size });
    };
    send();
    const timer = window.setInterval(send, SEND_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [color, size, spraying, tool, userId]);

  useEffect(() => {
    if (mode !== "air" || !motionEnabled) return;

    let gotEvent = false;

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (typeof event.gamma !== "number" || typeof event.beta !== "number") return;
      if (!gotEvent) {
        gotEvent = true;
        setMotionStatus("Motion live");
      }

      const zero = orientationZeroRef.current ?? { beta: event.beta, gamma: event.gamma };
      orientationZeroRef.current = zero;

      const deltaYaw = clamp(event.gamma - zero.gamma, -AIR_YAW_RANGE, AIR_YAW_RANGE);
      const deltaPitch = clamp(event.beta - zero.beta, -AIR_PITCH_RANGE, AIR_PITCH_RANGE);
      const mappedX = ((deltaYaw + AIR_YAW_RANGE) / (AIR_YAW_RANGE * 2)) * WALL_SIZE.width;
      const mappedY = ((deltaPitch + AIR_PITCH_RANGE) / (AIR_PITCH_RANGE * 2)) * WALL_SIZE.height;

      const nextX = clamp(
        pointRef.current.x + (mappedX - pointRef.current.x) * AIR_SMOOTHING,
        0,
        WALL_SIZE.width
      );
      const nextY = clamp(
        pointRef.current.y + (mappedY - pointRef.current.y) * AIR_SMOOTHING,
        0,
        WALL_SIZE.height
      );
      const next = { x: nextX, y: nextY };
      pointRef.current = next;
      setAimPoint(next);
    };

    window.addEventListener("deviceorientation", onOrientation);
    const checkTimer = window.setTimeout(() => {
      if (!gotEvent) setMotionStatus("No sensor (HTTPS/permission required)");
    }, 1500);

    return () => {
      window.clearTimeout(checkTimer);
      window.removeEventListener("deviceorientation", onOrientation);
    };
  }, [mode, motionEnabled]);

  function setPointFromTouch(clientX: number, clientY: number) {
    const element = surfaceRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const x = clamp(((clientX - rect.left) / rect.width) * WALL_SIZE.width, 0, WALL_SIZE.width);
    const y = clamp(((clientY - rect.top) / rect.height) * WALL_SIZE.height, 0, WALL_SIZE.height);
    const next = { x, y };
    pointRef.current = next;
    orientationZeroRef.current = null; // recalibrate from new touch position
    setAimPoint(next);
  }

  async function enableMotion() {
    try {
      const orientationRequest = (
        DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
      ).requestPermission;
      const motionRequest = (
        DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }
      ).requestPermission;

      setMode("air");
      orientationZeroRef.current = null;

      if (typeof orientationRequest === "function") {
        const result = await orientationRequest();
        if (typeof motionRequest === "function") await motionRequest();
        const granted = result === "granted";
        setMotionEnabled(granted);
        setMotionStatus(granted ? "Permission granted" : "Permission denied");
        return;
      }
      setMotionEnabled(true);
      setMotionStatus("Motion enabled");
    } catch {
      setMotionEnabled(false);
      setMotionStatus("Motion permission error");
    }
  }

  function sendUndo() {
    socketRef.current?.emit("stroke:undo", { userId });
  }

  function recenter() {
    pointRef.current = CENTER_POINT;
    orientationZeroRef.current = null;
    setAimPoint(CENTER_POINT);
  }

  return (
    <main
      className="air-shell"
      onContextMenu={(e) => e.preventDefault()}
    >
      <header className="air-header">
        <div>
          <p className="eyebrow">Mobile Controller</p>
          <h1>Air Spray</h1>
        </div>
        <div className="air-status">
          <span className={connected ? "status-dot is-online" : "status-dot"} />
          <span>{connected ? "Live" : "Offline"}</span>
          <span>{motionStatus}</span>
        </div>
      </header>

      <section className="air-controls">
        <div className="toolbar-group">
          <button
            className={`icon-button ${mode === "touch" ? "is-active" : ""}`}
            type="button"
            onClick={() => setMode("touch")}
          >
            <Smartphone size={18} />
          </button>
          <button
            className={`icon-button ${mode === "air" ? "is-active" : ""}`}
            type="button"
            onClick={enableMotion}
          >
            <Waves size={18} />
          </button>
          <button
            className={`icon-button ${tool === "brush" ? "is-active" : ""}`}
            type="button"
            onClick={() => setTool("brush")}
          >
            <Brush size={18} />
          </button>
          <button
            className={`icon-button ${tool === "eraser" ? "is-active" : ""}`}
            type="button"
            onClick={() => setTool("eraser")}
          >
            <Eraser size={18} />
          </button>
          <button className="icon-button" type="button" onClick={sendUndo}>
            <Undo2 size={18} />
          </button>
        </div>

        <div className="toolbar-group color-group">
          {DEFAULT_COLORS.map((swatch) => (
            <button
              key={swatch}
              className={`swatch ${color === swatch ? "is-active" : ""}`}
              style={{ backgroundColor: swatch }}
              type="button"
              onClick={() => {
                setColor(swatch);
                setTool("brush");
              }}
            />
          ))}
        </div>

        <div className="toolbar-group size-group">
          <input
            aria-label="Brush size"
            className="size-slider"
            min={2}
            max={72}
            step={1}
            type="range"
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
          <span className="air-size-label">{size}px</span>
        </div>
      </section>

      <section className="air-stage">
        <div
          ref={surfaceRef}
          className={`air-surface ${spraying ? "is-spraying" : ""}`}
          onPointerDown={(e) => {
            setPointFromTouch(e.clientX, e.clientY);
            if (mode === "touch") setSpraying(true);
          }}
          onPointerMove={(e) => {
            if (mode === "touch" && e.buttons !== 1) return;
            setPointFromTouch(e.clientX, e.clientY);
          }}
          onPointerUp={() => { if (mode === "touch") setSpraying(false); }}
          onPointerCancel={() => { if (mode === "touch") setSpraying(false); }}
        >
          <span className="air-indicator" style={indicatorStyle} />
        </div>

        <div className="air-actions">
          <button
            className={`air-spray-button ${spraying ? "is-spraying" : ""}`}
            type="button"
            onPointerDown={() => setSpraying(true)}
            onPointerUp={() => setSpraying(false)}
            onPointerCancel={() => setSpraying(false)}
          >
            Hold to Spray
          </button>
          <button className="icon-button" type="button" onClick={recenter}>
            Recenter
          </button>
          {mode === "air" && (
            <button className="icon-button" type="button" onClick={() => {
              orientationZeroRef.current = null;
              setMotionStatus("Calibrating...");
            }}>
              Calibrate
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
