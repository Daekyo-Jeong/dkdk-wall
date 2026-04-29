"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Brush, Eraser, Smartphone, Undo2, Waves } from "lucide-react";
import { clamp, DEFAULT_COLORS, WALL_SIZE, generateId, type WallTool } from "@/lib/wall";

type AimPoint = { x: number; y: number };

const SEND_INTERVAL_MS = 33;
const VELOCITY_DECAY = 0.85;
const MOTION_SENSITIVITY = 280;
const MOTION_THRESHOLD = 0.2;
const GRAVITY_ALPHA = 0.8;
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
  const velRef = useRef({ x: 0, y: 0 });
  const gravityRef = useRef({ x: 0, y: 0 });
  const sendTimerRef = useRef<number | null>(null);

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
      boxShadow: `0 0 0 5px ${color}30`,
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
    sendTimerRef.current = timer;
    return () => {
      window.clearInterval(timer);
      sendTimerRef.current = null;
    };
  }, [color, size, spraying, tool, userId]);

  useEffect(() => {
    if (mode !== "air" || !motionEnabled) return;

    let gotEvent = false;

    const onMotion = (event: DeviceMotionEvent) => {
      if (!gotEvent) {
        gotEvent = true;
        setMotionStatus("Motion live");
      }

      const dt = 0.016;

      // Use linear acceleration if available, otherwise subtract estimated gravity
      let ax: number;
      let ay: number;

      if (event.acceleration?.x != null) {
        ax = event.acceleration.x ?? 0;
        ay = event.acceleration.y ?? 0;
      } else {
        const rawX = event.accelerationIncludingGravity?.x ?? 0;
        const rawY = event.accelerationIncludingGravity?.y ?? 0;
        gravityRef.current.x = GRAVITY_ALPHA * gravityRef.current.x + (1 - GRAVITY_ALPHA) * rawX;
        gravityRef.current.y = GRAVITY_ALPHA * gravityRef.current.y + (1 - GRAVITY_ALPHA) * rawY;
        ax = rawX - gravityRef.current.x;
        ay = rawY - gravityRef.current.y;
      }

      // Dead zone
      const fx = Math.abs(ax) > MOTION_THRESHOLD ? ax : 0;
      const fy = Math.abs(ay) > MOTION_THRESHOLD ? ay : 0;

      // Integrate: acceleration → velocity → position
      // ax positive = phone moved right → wall x increases
      // ay positive = phone moved up → wall y decreases (screen y is inverted)
      velRef.current.x = velRef.current.x * VELOCITY_DECAY + fx * MOTION_SENSITIVITY * dt;
      velRef.current.y = velRef.current.y * VELOCITY_DECAY + (-fy) * MOTION_SENSITIVITY * dt;

      const nextX = clamp(pointRef.current.x + velRef.current.x, 0, WALL_SIZE.width);
      const nextY = clamp(pointRef.current.y + velRef.current.y, 0, WALL_SIZE.height);
      const next = { x: nextX, y: nextY };
      pointRef.current = next;
      setAimPoint(next);
    };

    window.addEventListener("devicemotion", onMotion);
    const checkTimer = window.setTimeout(() => {
      if (!gotEvent) setMotionStatus("No sensor (HTTPS/permission required)");
    }, 1500);

    return () => {
      window.clearTimeout(checkTimer);
      window.removeEventListener("devicemotion", onMotion);
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
    velRef.current = { x: 0, y: 0 }; // reset velocity on touch reposition
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
    const socket = socketRef.current;
    if (!socket || userId === "loading") return;
    socket.emit("stroke:undo", { userId });
  }

  function recenter() {
    pointRef.current = CENTER_POINT;
    velRef.current = { x: 0, y: 0 };
    setAimPoint(CENTER_POINT);
  }

  return (
    <main className="air-shell">
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
            onChange={(event) => setSize(Number(event.target.value))}
          />
          <span className="air-size-label">{size}px</span>
        </div>
      </section>

      <section className="air-stage">
        <div
          ref={surfaceRef}
          className={`air-surface ${spraying ? "is-spraying" : ""}`}
          onPointerDown={(event) => {
            setPointFromTouch(event.clientX, event.clientY);
            if (mode === "touch") setSpraying(true);
          }}
          onPointerMove={(event) => {
            if (mode === "touch" && event.buttons !== 1) return;
            setPointFromTouch(event.clientX, event.clientY);
          }}
          onPointerUp={() => {
            if (mode === "touch") setSpraying(false);
          }}
          onPointerCancel={() => {
            if (mode === "touch") setSpraying(false);
          }}
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
        </div>
      </section>
    </main>
  );
}
