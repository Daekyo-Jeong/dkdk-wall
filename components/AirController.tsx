"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Brush, Combine, Compass, Crosshair, Eraser, RefreshCw, Smartphone, SprayCan, Undo2, Waves } from "lucide-react";
import { clamp, DEFAULT_COLORS, WALL_SIZE, generateId, type WallTool } from "@/lib/wall";

type AimPoint = { x: number; y: number };
type Mode = "touch" | "air" | "gyro" | "fusion";

const SEND_INTERVAL_MS = 33;
const DEFAULT_VELOCITY_DECAY   = 0.88;
const DEFAULT_MOTION_SENSITIVITY = 140;
const DEFAULT_MOTION_THRESHOLD = 0.3;
const DEFAULT_GYRO_RANGE       = 45;   // degrees: center → edge
const DEFAULT_FUSION_BOOST     = 60;   // accel overlay strength in fusion mode
const GRAVITY_ALPHA            = 0.8;
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
    return true;
  } catch {
    return false;
  }
}

export function AirController() {
  const socketRef      = useRef<Socket | null>(null);
  const surfaceRef     = useRef<HTMLDivElement | null>(null);
  const pointRef       = useRef<AimPoint>(CENTER_POINT);
  const velRef         = useRef({ x: 0, y: 0 });
  const gravityRef     = useRef({ x: 0, y: 0 });
  const zeroOrientRef  = useRef({ gamma: 0, beta: 0 });
  const currentOrientRef = useRef({ gamma: 0, beta: 0 });

  const [connected,         setConnected]         = useState(false);
  const [tool,              setTool]              = useState<WallTool>("brush");
  const [color,             setColor]             = useState(DEFAULT_COLORS[0]);
  const [size,              setSize]              = useState(20);
  const [mode,              setMode]              = useState<Mode>("touch");
  const [userId]                                  = useState(() =>
    typeof window === "undefined" ? "loading" : getOrCreateAirUserId()
  );
  const [motionEnabled,     setMotionEnabled]     = useState(false);
  const [motionStatus,      setMotionStatus]      = useState("off");
  const [aimPoint,          setAimPoint]          = useState<AimPoint>(CENTER_POINT);
  const [spraying,          setSpraying]          = useState(false);
  const [motionSensitivity, setMotionSensitivity] = useState(DEFAULT_MOTION_SENSITIVITY);
  const [motionThreshold,   setMotionThreshold]   = useState(DEFAULT_MOTION_THRESHOLD);
  const [velocityDecay,     setVelocityDecay]     = useState(DEFAULT_VELOCITY_DECAY);
  const [gyroRange,         setGyroRange]         = useState(DEFAULT_GYRO_RANGE);
  const [fusionBoost,       setFusionBoost]       = useState(DEFAULT_FUSION_BOOST);
  const [flipX,             setFlipX]             = useState(false);
  const [flipY,             setFlipY]             = useState(false);

  const isMotionMode = mode === "air" || mode === "gyro" || mode === "fusion";

  const indicatorStyle = useMemo(
    () => ({
      left: `${(aimPoint.x / WALL_SIZE.width) * 100}%`,
      top:  `${(aimPoint.y / WALL_SIZE.height) * 100}%`,
      borderColor: color,
      boxShadow: spraying
        ? `0 0 0 6px ${color}50, 0 0 16px 4px ${color}40`
        : `0 0 0 4px ${color}28`,
    }),
    [aimPoint.x, aimPoint.y, color, spraying]
  );

  // ── Socket ────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect",    () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  // ── Position broadcast ────────────────────────────────────────────
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

  // ── Accelerometer helper (shared by air + fusion) ─────────────────
  function readAccel(event: DeviceMotionEvent): { fx: number; fy: number } {
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
    return {
      fx: Math.abs(ax) > motionThreshold ? ax : 0,
      fy: Math.abs(ay) > motionThreshold ? ay : 0,
    };
  }

  // ── Air mode (accelerometer only) ────────────────────────────────
  useEffect(() => {
    if (mode !== "air" || !motionEnabled) return;
    let gotEvent = false;
    const dt = 0.016;

    const onMotion = (event: DeviceMotionEvent) => {
      if (!gotEvent) { gotEvent = true; setMotionStatus("live"); }
      const { fx, fy } = readAccel(event);
      const xDir = flipX ? -1 : 1;
      const yDir = flipY ? -1 : 1;
      velRef.current.x = velRef.current.x * velocityDecay + fx * xDir * motionSensitivity * dt;
      velRef.current.y = velRef.current.y * velocityDecay + (-fy) * yDir * motionSensitivity * dt;
      const next = {
        x: clamp(pointRef.current.x + velRef.current.x, 0, WALL_SIZE.width),
        y: clamp(pointRef.current.y + velRef.current.y, 0, WALL_SIZE.height),
      };
      pointRef.current = next;
      setAimPoint(next);
    };

    window.addEventListener("devicemotion", onMotion);
    const checkTimer = window.setTimeout(() => { if (!gotEvent) setMotionStatus("no sensor"); }, 1500);
    return () => { window.clearTimeout(checkTimer); window.removeEventListener("devicemotion", onMotion); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipX, flipY, mode, motionEnabled, motionSensitivity, motionThreshold, velocityDecay]);

  // ── Gyro mode (orientation only) ─────────────────────────────────
  useEffect(() => {
    if (mode !== "gyro" || !motionEnabled) return;
    let gotEvent = false;

    const onOrient = (event: DeviceOrientationEvent) => {
      const gamma = event.gamma ?? 0;
      const beta  = event.beta  ?? 0;
      currentOrientRef.current = { gamma, beta };
      if (!gotEvent) { gotEvent = true; zeroOrientRef.current = { gamma, beta }; setMotionStatus("live"); }

      const xDir = flipX ? -1 : 1;
      const yDir = flipY ? -1 : 1;
      const dGamma = gamma - zeroOrientRef.current.gamma;
      const dBeta  = beta  - zeroOrientRef.current.beta;
      const next = {
        x: clamp(WALL_SIZE.width  / 2 + (dGamma * xDir * WALL_SIZE.width)  / (2 * gyroRange), 0, WALL_SIZE.width),
        y: clamp(WALL_SIZE.height / 2 + (dBeta  * yDir * WALL_SIZE.height) / (2 * gyroRange), 0, WALL_SIZE.height),
      };
      pointRef.current = next;
      setAimPoint(next);
    };

    window.addEventListener("deviceorientation", onOrient);
    const checkTimer = window.setTimeout(() => { if (!gotEvent) setMotionStatus("no sensor"); }, 1500);
    return () => { window.clearTimeout(checkTimer); window.removeEventListener("deviceorientation", onOrient); };
  }, [flipX, flipY, gyroRange, mode, motionEnabled]);

  // ── Fusion mode (gyro base + accel overlay) ───────────────────────
  //    자이로 → 절대 위치 기준  /  가속도 → 그 위에 속도 오프셋
  useEffect(() => {
    if (mode !== "fusion" || !motionEnabled) return;
    let gotOrient = false;
    const dt = 0.016;

    // 가속도: velRef만 업데이트 (렌더링은 orientation 핸들러가 담당)
    const onMotion = (event: DeviceMotionEvent) => {
      const { fx, fy } = readAccel(event);
      const xDir = flipX ? -1 : 1;
      const yDir = flipY ? -1 : 1;
      velRef.current.x = velRef.current.x * velocityDecay + fx  * xDir * fusionBoost * dt;
      velRef.current.y = velRef.current.y * velocityDecay + (-fy) * yDir * fusionBoost * dt;
    };

    // 자이로: 기준 좌표 계산 후 가속도 오프셋 합산 → 최종 위치
    const onOrient = (event: DeviceOrientationEvent) => {
      const gamma = event.gamma ?? 0;
      const beta  = event.beta  ?? 0;
      currentOrientRef.current = { gamma, beta };
      if (!gotOrient) { gotOrient = true; zeroOrientRef.current = { gamma, beta }; setMotionStatus("live"); }

      const xDir = flipX ? -1 : 1;
      const yDir = flipY ? -1 : 1;
      const dGamma = gamma - zeroOrientRef.current.gamma;
      const dBeta  = beta  - zeroOrientRef.current.beta;

      const baseX = WALL_SIZE.width  / 2 + (dGamma * xDir * WALL_SIZE.width)  / (2 * gyroRange);
      const baseY = WALL_SIZE.height / 2 + (dBeta  * yDir * WALL_SIZE.height) / (2 * gyroRange);

      const next = {
        x: clamp(baseX + velRef.current.x, 0, WALL_SIZE.width),
        y: clamp(baseY + velRef.current.y, 0, WALL_SIZE.height),
      };
      pointRef.current = next;
      setAimPoint(next);
    };

    window.addEventListener("devicemotion",      onMotion);
    window.addEventListener("deviceorientation", onOrient);
    const checkTimer = window.setTimeout(() => { if (!gotOrient) setMotionStatus("no sensor"); }, 1500);
    return () => {
      window.clearTimeout(checkTimer);
      window.removeEventListener("devicemotion",      onMotion);
      window.removeEventListener("deviceorientation", onOrient);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipX, flipY, fusionBoost, gyroRange, mode, motionEnabled, motionThreshold, velocityDecay]);

  // ── Touch positioning ─────────────────────────────────────────────
  function setPointFromTouch(clientX: number, clientY: number) {
    const el = surfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = {
      x: clamp(((clientX - rect.left) / rect.width)  * WALL_SIZE.width,  0, WALL_SIZE.width),
      y: clamp(((clientY - rect.top)  / rect.height) * WALL_SIZE.height, 0, WALL_SIZE.height),
    };
    pointRef.current = next;
    velRef.current   = { x: 0, y: 0 };
    setAimPoint(next);
  }

  // ── Mode activation ───────────────────────────────────────────────
  async function enableAir() {
    setMode("air");
    velRef.current     = { x: 0, y: 0 };
    gravityRef.current = { x: 0, y: 0 };
    setMotionStatus("ready");
    const ok = await requestSensorPermission();
    setMotionEnabled(ok);
    setMotionStatus(ok ? "ready" : "denied");
  }

  async function enableGyro() {
    setMode("gyro");
    zeroOrientRef.current = { gamma: 0, beta: 0 };
    setMotionStatus("ready");
    const ok = await requestSensorPermission();
    setMotionEnabled(ok);
    setMotionStatus(ok ? "ready" : "denied");
  }

  async function enableFusion() {
    setMode("fusion");
    velRef.current        = { x: 0, y: 0 };
    gravityRef.current    = { x: 0, y: 0 };
    zeroOrientRef.current = { gamma: 0, beta: 0 };
    setMotionStatus("ready");
    const ok = await requestSensorPermission();
    setMotionEnabled(ok);
    setMotionStatus(ok ? "ready" : "denied");
  }

  // ── Recenter ──────────────────────────────────────────────────────
  function recenter() {
    if (mode === "gyro" || mode === "fusion") {
      zeroOrientRef.current = { ...currentOrientRef.current };
    }
    velRef.current    = { x: 0, y: 0 };
    pointRef.current  = CENTER_POINT;
    setAimPoint(CENTER_POINT);
  }

  // ── Render ────────────────────────────────────────────────────────
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
          <button
            className={`icon-button ${mode === "touch" ? "is-active" : ""}`}
            type="button"
            onClick={() => { setMode("touch"); setMotionEnabled(false); setMotionStatus("off"); }}
            title="터치 모드"
          >
            <Smartphone size={18} />
          </button>
          <button
            className={`icon-button ${mode === "air" ? "is-active" : ""}`}
            type="button"
            onClick={enableAir}
            title="가속도계 모드"
          >
            <Waves size={18} />
          </button>
          <button
            className={`icon-button ${mode === "gyro" ? "is-active" : ""}`}
            type="button"
            onClick={enableGyro}
            title="자이로 모드"
          >
            <Compass size={18} />
          </button>
          <button
            className={`icon-button ${mode === "fusion" ? "is-active" : ""}`}
            type="button"
            onClick={enableFusion}
            title="융합 모드 (자이로 + 가속도)"
          >
            <Combine size={18} />
          </button>

          <button
            className={`icon-button ${tool === "brush" ? "is-active" : ""}`}
            type="button"
            onClick={() => setTool("brush")}
            title="브러시"
          >
            <Brush size={18} />
          </button>
          <button
            className={`icon-button ${tool === "eraser" ? "is-active" : ""}`}
            type="button"
            onClick={() => setTool("eraser")}
            title="지우개"
          >
            <Eraser size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => socketRef.current?.emit("stroke:undo", { userId })}
            title="실행 취소"
          >
            <Undo2 size={18} />
          </button>
        </div>
      </header>

      <section className="air-controls">
        {/* 색상 스와치 */}
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

        {/* 크기 슬라이더 */}
        <div className="toolbar-group size-group">
          <input
            aria-label="브러시 크기"
            className="size-slider"
            min={2} max={72} step={1}
            type="range"
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
          <span className="air-size-label">{size}px</span>
        </div>

        {/* 모션 컨트롤 */}
        {isMotionMode && (
          <div className="air-motion-controls">

            {/* Air 전용 */}
            {mode === "air" && (
              <>
                <label className="air-motion-control">
                  <span>Sensitivity</span>
                  <input aria-label="감도" min={40} max={320} step={10} type="range"
                    value={motionSensitivity} onChange={(e) => setMotionSensitivity(Number(e.target.value))} />
                  <output>{motionSensitivity}</output>
                </label>
                <label className="air-motion-control">
                  <span>Deadzone</span>
                  <input aria-label="데드존" min={0} max={1.2} step={0.05} type="range"
                    value={motionThreshold} onChange={(e) => setMotionThreshold(Number(e.target.value))} />
                  <output>{motionThreshold.toFixed(2)}</output>
                </label>
                <label className="air-motion-control">
                  <span>Damping</span>
                  <input aria-label="감쇠" min={0.5} max={0.98} step={0.01} type="range"
                    value={velocityDecay} onChange={(e) => setVelocityDecay(Number(e.target.value))} />
                  <output>{velocityDecay.toFixed(2)}</output>
                </label>
              </>
            )}

            {/* Gyro 전용 */}
            {mode === "gyro" && (
              <label className="air-motion-control">
                <span>Range °</span>
                <input aria-label="자이로 범위" min={10} max={90} step={5} type="range"
                  value={gyroRange} onChange={(e) => setGyroRange(Number(e.target.value))} />
                <output>{gyroRange}°</output>
              </label>
            )}

            {/* Fusion 전용 */}
            {mode === "fusion" && (
              <>
                <label className="air-motion-control">
                  <span>Range °</span>
                  <input aria-label="자이로 범위" min={10} max={90} step={5} type="range"
                    value={gyroRange} onChange={(e) => setGyroRange(Number(e.target.value))} />
                  <output>{gyroRange}°</output>
                </label>
                <label className="air-motion-control">
                  <span>Boost</span>
                  <input aria-label="가속도 부스트" min={10} max={200} step={10} type="range"
                    value={fusionBoost} onChange={(e) => setFusionBoost(Number(e.target.value))} />
                  <output>{fusionBoost}</output>
                </label>
                <label className="air-motion-control">
                  <span>Damping</span>
                  <input aria-label="감쇠" min={0.5} max={0.98} step={0.01} type="range"
                    value={velocityDecay} onChange={(e) => setVelocityDecay(Number(e.target.value))} />
                  <output>{velocityDecay.toFixed(2)}</output>
                </label>
              </>
            )}

            {/* Flip — 모든 모션 모드 공통 */}
            <div className="air-flip-group">
              <button
                className={`air-toggle-button ${flipX ? "is-active" : ""}`}
                type="button"
                onClick={() => { velRef.current = { x: 0, y: 0 }; setFlipX((v) => !v); }}
              >
                Flip X
              </button>
              <button
                className={`air-toggle-button ${flipY ? "is-active" : ""}`}
                type="button"
                onClick={() => { velRef.current = { x: 0, y: 0 }; setFlipY((v) => !v); }}
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
          onPointerDown={(e) => { setPointFromTouch(e.clientX, e.clientY); if (mode === "touch") setSpraying(true); }}
          onPointerMove={(e) => { if (mode === "touch" && e.buttons !== 1) return; setPointFromTouch(e.clientX, e.clientY); }}
          onPointerUp={() => { if (mode === "touch") setSpraying(false); }}
          onPointerCancel={() => { if (mode === "touch") setSpraying(false); }}
        >
          <span className={`air-indicator ${spraying ? "is-spraying" : ""}`} style={indicatorStyle} />
        </div>

        <div className="air-actions">
          <button className="icon-button" type="button" onClick={recenter} title="재조준">
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
              onClick={() => { velRef.current = { x: 0, y: 0 }; gravityRef.current = { x: 0, y: 0 }; setMotionStatus("ready"); }}
              title="드리프트 초기화"
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
