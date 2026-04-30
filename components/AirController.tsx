"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Brush, Compass, Crosshair, Eraser, RefreshCw, Smartphone, SprayCan, Undo2, Waves } from "lucide-react";
import { clamp, DEFAULT_COLORS, WALL_SIZE, generateId, type WallTool } from "@/lib/wall";

type AimPoint = { x: number; y: number };
type Mode = "touch" | "air" | "gyro";

const SEND_INTERVAL_MS = 33;
const DEFAULT_VELOCITY_DECAY = 0.88;
const DEFAULT_MOTION_SENSITIVITY = 140;
const DEFAULT_MOTION_THRESHOLD = 0.3;
const DEFAULT_GYRO_RANGE = 45; // degrees from center to wall edge
const GRAVITY_ALPHA = 0.8;
const CENTER_POINT: AimPoint = { x: WALL_SIZE.width / 2, y: WALL_SIZE.height / 2 };

function getOrCreateAirUserId() {
  const saved = window.localStorage.getItem("wall-air-user-id");
  if (saved) return saved;
  const next = `air-${generateId()}`;
  window.localStorage.setItem("wall-air-user-id", next);
  return next;
}

async function requestSensorPermission(): Promise<boolean> {
  try {
    const orientReq = (
      DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
    ).requestPermission;
    const motionReq = (
      DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }
    ).requestPermission;
    if (typeof orientReq === "function") {
      const result = await orientReq();
      if (typeof motionReq === "function") await motionReq();
      return result === "granted";
    }
    return true; // non-iOS: always available
  } catch {
    return false;
  }
}

export function AirController() {
  const socketRef = useRef<Socket | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pointRef = useRef<AimPoint>(CENTER_POINT);
  const velRef = useRef({ x: 0, y: 0 });
  const gravityRef = useRef({ x: 0, y: 0 });
  const zeroOrientRef = useRef({ gamma: 0, beta: 0 });
  const currentOrientRef = useRef({ gamma: 0, beta: 0 });

  const [connected, setConnected] = useState(false);
  const [tool, setTool] = useState<WallTool>("brush");
  const [color, setColor] = useState(DEFAULT_COLORS[0]);
  const [size, setSize] = useState(20);
  const [mode, setMode] = useState<Mode>("touch");
  const [userId] = useState(() =>
    typeof window === "undefined" ? "loading" : getOrCreateAirUserId()
  );
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [motionStatus, setMotionStatus] = useState("off");
  const [aimPoint, setAimPoint] = useState<AimPoint>(CENTER_POINT);
  const [spraying, setSpraying] = useState(false);
  const [motionSensitivity, setMotionSensitivity] = useState(DEFAULT_MOTION_SENSITIVITY);
  const [motionThreshold, setMotionThreshold] = useState(DEFAULT_MOTION_THRESHOLD);
  const [velocityDecay, setVelocityDecay] = useState(DEFAULT_VELOCITY_DECAY);
  const [gyroRange, setGyroRange] = useState(DEFAULT_GYRO_RANGE);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);

  const indicatorStyle = useMemo(
    () => ({
      left: `${(aimPoint.x / WALL_SIZE.width) * 100}%`,
      top: `${(aimPoint.y / WALL_SIZE.height) * 100}%`,
      borderColor: color,
      boxShadow: spraying
        ? `0 0 0 6px ${color}50, 0 0 16px 4px ${color}40`
        : `0 0 0 4px ${color}28`
    }),
    [aimPoint.x, aimPoint.y, color, spraying]
  );

  // ── Socket connection ──────────────────────────────────────────────
  useEffect(() => {
    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  // ── Position broadcast ─────────────────────────────────────────────
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

  // ── Accelerometer (air mode) ───────────────────────────────────────
  useEffect(() => {
    if (mode !== "air" || !motionEnabled) return;

    let gotEvent = false;

    const onMotion = (event: DeviceMotionEvent) => {
      if (!gotEvent) { gotEvent = true; setMotionStatus("live"); }

      const dt = 0.016;
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

      const fx = Math.abs(ax) > motionThreshold ? ax : 0;
      const fy = Math.abs(ay) > motionThreshold ? ay : 0;
      const xDir = flipX ? -1 : 1;
      const yDir = flipY ? -1 : 1;

      velRef.current.x =
        velRef.current.x * velocityDecay +
        fx * xDir * motionSensitivity * dt;
      velRef.current.y =
        velRef.current.y * velocityDecay +
        (-fy) * yDir * motionSensitivity * dt;

      const nextX = clamp(pointRef.current.x + velRef.current.x, 0, WALL_SIZE.width);
      const nextY = clamp(pointRef.current.y + velRef.current.y, 0, WALL_SIZE.height);
      const next = { x: nextX, y: nextY };
      pointRef.current = next;
      setAimPoint(next);
    };

    window.addEventListener("devicemotion", onMotion);
    const checkTimer = window.setTimeout(() => {
      if (!gotEvent) setMotionStatus("no sensor");
    }, 1500);

    return () => {
      window.clearTimeout(checkTimer);
      window.removeEventListener("devicemotion", onMotion);
    };
  }, [flipX, flipY, mode, motionEnabled, motionSensitivity, motionThreshold, velocityDecay]);

  // ── Gyroscope (gyro mode) ──────────────────────────────────────────
  useEffect(() => {
    if (mode !== "gyro" || !motionEnabled) return;

    let gotEvent = false;

    const onOrient = (event: DeviceOrientationEvent) => {
      const gamma = event.gamma ?? 0; // left–right tilt: –90 to +90°
      const beta  = event.beta  ?? 0; // forward–back tilt: –180 to +180°

      currentOrientRef.current = { gamma, beta };

      if (!gotEvent) {
        gotEvent = true;
        zeroOrientRef.current = { gamma, beta };
        setMotionStatus("live");
      }

      const dGamma = gamma - zeroOrientRef.current.gamma;
      const dBeta  = beta  - zeroOrientRef.current.beta;

      const xDir = flipX ? -1 : 1;
      const yDir = flipY ? -1 : 1;

      // Map ±gyroRange degrees → full wall width/height
      const x = clamp(
        WALL_SIZE.width  / 2 + (dGamma * xDir * WALL_SIZE.width)  / (2 * gyroRange),
        0, WALL_SIZE.width
      );
      const y = clamp(
        WALL_SIZE.height / 2 + (dBeta  * yDir * WALL_SIZE.height) / (2 * gyroRange),
        0, WALL_SIZE.height
      );

      const next = { x, y };
      pointRef.current = next;
      setAimPoint(next);
    };

    window.addEventListener("deviceorientation", onOrient);
    const checkTimer = window.setTimeout(() => {
      if (!gotEvent) setMotionStatus("no sensor");
    }, 1500);

    return () => {
      window.clearTimeout(checkTimer);
      window.removeEventListener("deviceorientation", onOrient);
    };
  }, [flipX, flipY, gyroRange, mode, motionEnabled]);

  // ── Touch / pointer positioning ────────────────────────────────────
  function setPointFromTouch(clientX: number, clientY: number) {
    const element = surfaceRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const x = clamp(((clientX - rect.left) / rect.width) * WALL_SIZE.width, 0, WALL_SIZE.width);
    const y = clamp(((clientY - rect.top) / rect.height) * WALL_SIZE.height, 0, WALL_SIZE.height);
    const next = { x, y };
    pointRef.current = next;
    velRef.current = { x: 0, y: 0 };
    setAimPoint(next);
  }

  // ── Mode activation ────────────────────────────────────────────────
  async function enableAir() {
    setMode("air");
    velRef.current = { x: 0, y: 0 };
    gravityRef.current = { x: 0, y: 0 };
    setMotionStatus("ready");
    const granted = await requestSensorPermission();
    setMotionEnabled(granted);
    setMotionStatus(granted ? "ready" : "denied");
  }

  async function enableGyro() {
    setMode("gyro");
    zeroOrientRef.current = { gamma: 0, beta: 0 };
    setMotionStatus("ready");
    const granted = await requestSensorPermission();
    setMotionEnabled(granted);
    setMotionStatus(granted ? "ready" : "denied");
  }

  // ── Recenter ───────────────────────────────────────────────────────
  function recenter() {
    if (mode === "gyro") {
      zeroOrientRef.current = { ...currentOrientRef.current };
    } else {
      velRef.current = { x: 0, y: 0 };
    }
    pointRef.current = CENTER_POINT;
    setAimPoint(CENTER_POINT);
  }

  const isMotionMode = mode === "air" || mode === "gyro";

  return (
    <main className="air-shell" onContextMenu={(e) => e.preventDefault()}>
      <header className="air-header">
        <div className="air-title">
          <p className="eyebrow">Air Spray</p>
          <div className="air-status">
            <span className={connected ? "status-dot is-online" : "status-dot"} />
            <span className="air-status-text">
              {connected ? "live" : "offline"}
              {isMotionMode && ` · ${motionStatus}`}
            </span>
          </div>
        </div>

        <div className="toolbar-group">
          {/* Mode buttons */}
          <button
            className={`icon-button ${mode === "touch" ? "is-active" : ""}`}
            type="button"
            onClick={() => { setMode("touch"); setMotionEnabled(false); setMotionStatus("off"); }}
            title="Touch mode"
          >
            <Smartphone size={18} />
          </button>
          <button
            className={`icon-button ${mode === "air" ? "is-active" : ""}`}
            type="button"
            onClick={enableAir}
            title="Accelerometer mode"
          >
            <Waves size={18} />
          </button>
          <button
            className={`icon-button ${mode === "gyro" ? "is-active" : ""}`}
            type="button"
            onClick={enableGyro}
            title="Gyroscope mode"
          >
            <Compass size={18} />
          </button>

          {/* Tool buttons */}
          <button
            className={`icon-button ${tool === "brush" ? "is-active" : ""}`}
            type="button"
            onClick={() => setTool("brush")}
            title="Brush"
          >
            <Brush size={18} />
          </button>
          <button
            className={`icon-button ${tool === "eraser" ? "is-active" : ""}`}
            type="button"
            onClick={() => setTool("eraser")}
            title="Eraser"
          >
            <Eraser size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => socketRef.current?.emit("stroke:undo", { userId })}
            title="Undo"
          >
            <Undo2 size={18} />
          </button>
        </div>
      </header>

      <section className="air-controls">
        {/* Color swatches */}
        <div className="toolbar-group color-group">
          {DEFAULT_COLORS.map((swatch) => (
            <button
              key={swatch}
              className={`swatch ${color === swatch ? "is-active" : ""}`}
              style={{ backgroundColor: swatch }}
              type="button"
              onClick={() => { setColor(swatch); setTool("brush"); }}
            />
          ))}
        </div>

        {/* Size slider */}
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

        {/* Motion controls */}
        {isMotionMode && (
          <div className="air-motion-controls">
            {/* Accelerometer-only sliders */}
            {mode === "air" && (
              <>
                <label className="air-motion-control">
                  <span>Sensitivity</span>
                  <input
                    aria-label="Motion sensitivity"
                    max={320}
                    min={40}
                    step={10}
                    type="range"
                    value={motionSensitivity}
                    onChange={(e) => setMotionSensitivity(Number(e.target.value))}
                  />
                  <output>{motionSensitivity}</output>
                </label>
                <label className="air-motion-control">
                  <span>Deadzone</span>
                  <input
                    aria-label="Motion deadzone"
                    max={1.2}
                    min={0}
                    step={0.05}
                    type="range"
                    value={motionThreshold}
                    onChange={(e) => setMotionThreshold(Number(e.target.value))}
                  />
                  <output>{motionThreshold.toFixed(2)}</output>
                </label>
                <label className="air-motion-control">
                  <span>Damping</span>
                  <input
                    aria-label="Motion damping"
                    max={0.98}
                    min={0.5}
                    step={0.01}
                    type="range"
                    value={velocityDecay}
                    onChange={(e) => setVelocityDecay(Number(e.target.value))}
                  />
                  <output>{velocityDecay.toFixed(2)}</output>
                </label>
              </>
            )}

            {/* Gyroscope-only slider */}
            {mode === "gyro" && (
              <label className="air-motion-control">
                <span>Range °</span>
                <input
                  aria-label="Gyro range in degrees"
                  max={90}
                  min={10}
                  step={5}
                  type="range"
                  value={gyroRange}
                  onChange={(e) => setGyroRange(Number(e.target.value))}
                />
                <output>{gyroRange}°</output>
              </label>
            )}

            {/* Flip buttons — shared for both modes */}
            <div className="air-flip-group">
              <button
                className={`air-toggle-button ${flipX ? "is-active" : ""}`}
                type="button"
                onClick={() => {
                  velRef.current = { x: 0, y: 0 };
                  setFlipX((v) => !v);
                }}
              >
                Flip X
              </button>
              <button
                className={`air-toggle-button ${flipY ? "is-active" : ""}`}
                type="button"
                onClick={() => {
                  velRef.current = { x: 0, y: 0 };
                  setFlipY((v) => !v);
                }}
              >
                Flip Y
              </button>
            </div>
          </div>
        )}
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
          <span className={`air-indicator ${spraying ? "is-spraying" : ""}`} style={indicatorStyle} />
        </div>

        <div className="air-actions">
          <button
            className="icon-button"
            type="button"
            onClick={recenter}
            title="Recenter"
          >
            <Crosshair size={18} />
          </button>

          <button
            className={`air-spray-button ${spraying ? "is-spraying" : ""}`}
            type="button"
            onPointerDown={() => setSpraying(true)}
            onPointerUp={() => setSpraying(false)}
            onPointerCancel={() => setSpraying(false)}
          >
            <SprayCan size={22} />
          </button>

          {isMotionMode ? (
            <button
              className="icon-button"
              type="button"
              onClick={() => {
                velRef.current = { x: 0, y: 0 };
                gravityRef.current = { x: 0, y: 0 };
                setMotionStatus("ready");
              }}
              title="Reset drift"
            >
              <RefreshCw size={18} />
            </button>
          ) : (
            <div style={{ width: 44 }} />
          )}
        </div>
      </section>
    </main>
  );
}
