"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Brush, Combine, Compass, Crosshair, Eraser, RefreshCw, Smartphone, SprayCan, Undo2, Waves } from "lucide-react";
import { clamp, DEFAULT_COLORS, WALL_SIZE, generateId, type WallTool } from "@/lib/wall";

type AimPoint  = { x: number; y: number };
type OrientPt  = { alpha: number; gamma: number; beta: number };
type SmoothPt  = { alpha: number; gamma: number; beta: number };
type Mode      = "touch" | "air" | "gyro" | "fusion";

const SEND_INTERVAL_MS         = 33;
const DEFAULT_VELOCITY_DECAY   = 0.88;
const DEFAULT_MOTION_SENSITIVITY = 140;
const DEFAULT_MOTION_THRESHOLD = 0.3;
const DEFAULT_GYRO_RANGE       = 45;
const DEFAULT_FUSION_BOOST     = 60;
const DEFAULT_GYRO_SMOOTH      = 0.5;   // EMA α  (0=raw, 0.9=heavy smooth)
const GRAVITY_ALPHA_COEFF      = 0.8;
const CENTER_POINT: AimPoint   = { x: WALL_SIZE.width / 2, y: WALL_SIZE.height / 2 };

/** alpha 델타 −180~+180 정규화 */
function wrapDelta(d: number): number {
  let r = d;
  while (r >  180) r -= 360;
  while (r < -180) r += 360;
  return r;
}

function getOrCreateAirUserId() {
  const saved = window.localStorage.getItem("wall-air-user-id");
  if (saved) return saved;
  const next = `air-${generateId()}`;
  window.localStorage.setItem("wall-air-user-id", next);
  return next;
}

async function requestSensorPermission(): Promise<boolean> {
  try {
    const orientReq = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    const motionReq  = (DeviceMotionEvent      as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    if (typeof orientReq === "function") {
      const result = await orientReq();
      if (typeof motionReq === "function") await motionReq();
      return result === "granted";
    }
    return true;
  } catch { return false; }
}

export function AirController() {
  const socketRef       = useRef<Socket | null>(null);
  const surfaceRef      = useRef<HTMLDivElement | null>(null);
  const pointRef        = useRef<AimPoint>(CENTER_POINT);
  const velRef          = useRef({ x: 0, y: 0 });
  const gravityRef      = useRef({ x: 0, y: 0 });
  const zeroOrientRef   = useRef<OrientPt>({ alpha: 0, gamma: 0, beta: 0 });
  const currentOrientRef= useRef<OrientPt>({ alpha: 0, gamma: 0, beta: 0 });
  // EMA 스무딩 누산값 (각도 델타 기준)
  const smoothRef       = useRef<SmoothPt>({ alpha: 0, gamma: 0, beta: 0 });

  const [connected,          setConnected]         = useState(false);
  const [tool,               setTool]              = useState<WallTool>("brush");
  const [color,              setColor]             = useState(DEFAULT_COLORS[0]);
  const [size,               setSize]              = useState(20);
  const [mode,               setMode]              = useState<Mode>("touch");
  const [userId]                                   = useState(() =>
    typeof window === "undefined" ? "loading" : getOrCreateAirUserId()
  );
  const [motionEnabled,      setMotionEnabled]     = useState(false);
  const [motionStatus,       setMotionStatus]      = useState("off");
  const [aimPoint,           setAimPoint]          = useState<AimPoint>(CENTER_POINT);
  const [spraying,           setSpraying]          = useState(false);
  const [motionSensitivity,  setMotionSensitivity] = useState(DEFAULT_MOTION_SENSITIVITY);
  const [motionThreshold,    setMotionThreshold]   = useState(DEFAULT_MOTION_THRESHOLD);
  const [velocityDecay,      setVelocityDecay]     = useState(DEFAULT_VELOCITY_DECAY);
  const [gyroRange,          setGyroRange]         = useState(DEFAULT_GYRO_RANGE);
  const [fusionBoost,        setFusionBoost]       = useState(DEFAULT_FUSION_BOOST);
  const [gyroSmooth,         setGyroSmooth]        = useState(DEFAULT_GYRO_SMOOTH);
  const [useYaw,             setUseYaw]            = useState(false);  // alpha(손목 회전) → X축
  const [flipX,              setFlipX]             = useState(false);
  const [flipY,              setFlipY]             = useState(false);

  const isMotionMode = mode === "air" || mode === "gyro" || mode === "fusion";

  const indicatorStyle = useMemo(() => ({
    left: `${(aimPoint.x / WALL_SIZE.width)  * 100}%`,
    top:  `${(aimPoint.y / WALL_SIZE.height) * 100}%`,
    borderColor: color,
    boxShadow: spraying
      ? `0 0 0 6px ${color}50, 0 0 16px 4px ${color}40`
      : `0 0 0 4px ${color}28`,
  }), [aimPoint.x, aimPoint.y, color, spraying]);

  // ── Socket ────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect",    () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  // ── Broadcast ─────────────────────────────────────────────────────
  useEffect(() => {
    const send = () => {
      const s = socketRef.current;
      if (!s || userId === "loading") return;
      s.emit("air:update", { userId, point: pointRef.current, spraying, tool, color, size });
    };
    send();
    const t = window.setInterval(send, SEND_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [color, size, spraying, tool, userId]);

  // ── 자이로(orientation) 공통 처리 ─────────────────────────────────
  //    스무딩 적용 후 X·Y 좌표 반환
  function applyOrientation(
    event: DeviceOrientationEvent,
    gotFirst: boolean,
  ): AimPoint {
    const alpha = event.alpha ?? 0;
    const gamma = event.gamma ?? 0;
    const beta  = event.beta  ?? 0;

    currentOrientRef.current = { alpha, gamma, beta };

    if (!gotFirst) {
      zeroOrientRef.current = { alpha, gamma, beta };
      smoothRef.current     = { alpha: 0, gamma: 0, beta: 0 };
    }

    const dAlpha = wrapDelta(alpha - zeroOrientRef.current.alpha);
    const dGamma = gamma - zeroOrientRef.current.gamma;
    const dBeta  = beta  - zeroOrientRef.current.beta;

    // EMA 저역통과 필터 — 떨림 억제
    const s = gyroSmooth;
    smoothRef.current.alpha = s * smoothRef.current.alpha + (1 - s) * dAlpha;
    smoothRef.current.gamma = s * smoothRef.current.gamma + (1 - s) * dGamma;
    smoothRef.current.beta  = s * smoothRef.current.beta  + (1 - s) * dBeta;

    const dX = useYaw ? smoothRef.current.alpha : smoothRef.current.gamma;
    const dY = smoothRef.current.beta;

    return {
      x: clamp(WALL_SIZE.width  / 2 + (dX * (flipX ? -1 : 1) * WALL_SIZE.width)  / (2 * gyroRange), 0, WALL_SIZE.width),
      y: clamp(WALL_SIZE.height / 2 + (dY * (flipY ? -1 : 1) * WALL_SIZE.height) / (2 * gyroRange), 0, WALL_SIZE.height),
    };
  }

  // ── 가속도계 공통 처리 (velRef 업데이트) ──────────────────────────
  function applyAccel(event: DeviceMotionEvent, strength: number) {
    let ax: number, ay: number;
    if (event.acceleration?.x != null) {
      ax = event.acceleration.x ?? 0;
      ay = event.acceleration.y ?? 0;
    } else {
      const rx = event.accelerationIncludingGravity?.x ?? 0;
      const ry = event.accelerationIncludingGravity?.y ?? 0;
      gravityRef.current.x = GRAVITY_ALPHA_COEFF * gravityRef.current.x + (1 - GRAVITY_ALPHA_COEFF) * rx;
      gravityRef.current.y = GRAVITY_ALPHA_COEFF * gravityRef.current.y + (1 - GRAVITY_ALPHA_COEFF) * ry;
      ax = rx - gravityRef.current.x;
      ay = ry - gravityRef.current.y;
    }
    const fx = Math.abs(ax) > motionThreshold ? ax : 0;
    const fy = Math.abs(ay) > motionThreshold ? ay : 0;
    const dt = 0.016;
    velRef.current.x = velRef.current.x * velocityDecay + fx * (flipX ? -1 : 1) * strength * dt;
    velRef.current.y = velRef.current.y * velocityDecay + (-fy) * (flipY ? -1 : 1) * strength * dt;
  }

  // ── Air 모드 ──────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "air" || !motionEnabled) return;
    let got = false;
    const onMotion = (e: DeviceMotionEvent) => {
      if (!got) { got = true; setMotionStatus("live"); }
      applyAccel(e, motionSensitivity);
      const next = {
        x: clamp(pointRef.current.x + velRef.current.x, 0, WALL_SIZE.width),
        y: clamp(pointRef.current.y + velRef.current.y, 0, WALL_SIZE.height),
      };
      pointRef.current = next;
      setAimPoint(next);
    };
    window.addEventListener("devicemotion", onMotion);
    const ck = window.setTimeout(() => { if (!got) setMotionStatus("no sensor"); }, 1500);
    return () => { window.clearTimeout(ck); window.removeEventListener("devicemotion", onMotion); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipX, flipY, mode, motionEnabled, motionSensitivity, motionThreshold, velocityDecay]);

  // ── Gyro 모드 ─────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "gyro" || !motionEnabled) return;
    let got = false;
    const onOrient = (e: DeviceOrientationEvent) => {
      const next = applyOrientation(e, got);
      if (!got) { got = true; setMotionStatus("live"); }
      pointRef.current = next;
      setAimPoint(next);
    };
    window.addEventListener("deviceorientation", onOrient);
    const ck = window.setTimeout(() => { if (!got) setMotionStatus("no sensor"); }, 1500);
    return () => { window.clearTimeout(ck); window.removeEventListener("deviceorientation", onOrient); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipX, flipY, gyroRange, gyroSmooth, mode, motionEnabled, useYaw]);

  // ── Fusion 모드 ───────────────────────────────────────────────────
  //    자이로 기준 위치 + 가속도 속도 오프셋
  useEffect(() => {
    if (mode !== "fusion" || !motionEnabled) return;
    let got = false;

    const onMotion  = (e: DeviceMotionEvent)      => { applyAccel(e, fusionBoost); };
    const onOrient  = (e: DeviceOrientationEvent) => {
      const base = applyOrientation(e, got);
      if (!got) { got = true; setMotionStatus("live"); }
      const next = {
        x: clamp(base.x + velRef.current.x, 0, WALL_SIZE.width),
        y: clamp(base.y + velRef.current.y, 0, WALL_SIZE.height),
      };
      pointRef.current = next;
      setAimPoint(next);
    };

    window.addEventListener("devicemotion",      onMotion);
    window.addEventListener("deviceorientation", onOrient);
    const ck = window.setTimeout(() => { if (!got) setMotionStatus("no sensor"); }, 1500);
    return () => {
      window.clearTimeout(ck);
      window.removeEventListener("devicemotion",      onMotion);
      window.removeEventListener("deviceorientation", onOrient);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipX, flipY, fusionBoost, gyroRange, gyroSmooth, mode, motionEnabled, motionThreshold, useYaw, velocityDecay]);

  // ── 터치 ──────────────────────────────────────────────────────────
  function setPointFromTouch(cx: number, cy: number) {
    const el = surfaceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = {
      x: clamp(((cx - r.left) / r.width)  * WALL_SIZE.width,  0, WALL_SIZE.width),
      y: clamp(((cy - r.top)  / r.height) * WALL_SIZE.height, 0, WALL_SIZE.height),
    };
    pointRef.current = next;
    velRef.current   = { x: 0, y: 0 };
    setAimPoint(next);
  }

  // ── 모드 전환 ─────────────────────────────────────────────────────
  function resetRefs() {
    velRef.current        = { x: 0, y: 0 };
    gravityRef.current    = { x: 0, y: 0 };
    zeroOrientRef.current = { alpha: 0, gamma: 0, beta: 0 };
    smoothRef.current     = { alpha: 0, gamma: 0, beta: 0 };
  }

  async function activate(next: Mode) {
    setMode(next);
    resetRefs();
    setMotionStatus("ready");
    if (next === "touch") { setMotionEnabled(false); setMotionStatus("off"); return; }
    const ok = await requestSensorPermission();
    setMotionEnabled(ok);
    setMotionStatus(ok ? "ready" : "denied");
  }

  // ── 재조준 ────────────────────────────────────────────────────────
  function recenter() {
    if (mode === "gyro" || mode === "fusion") {
      zeroOrientRef.current = { ...currentOrientRef.current };
      smoothRef.current     = { alpha: 0, gamma: 0, beta: 0 };
    }
    velRef.current   = { x: 0, y: 0 };
    pointRef.current = CENTER_POINT;
    setAimPoint(CENTER_POINT);
  }

  // ── Render ────────────────────────────────────────────────────────
  const showGyroControls   = mode === "gyro"   || mode === "fusion";
  const showAccelControls  = mode === "air";
  const showFusionControls = mode === "fusion";

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
          <button className={`icon-button ${mode === "touch"  ? "is-active" : ""}`} type="button"
            onClick={() => activate("touch")} title="터치 모드"><Smartphone size={18} /></button>
          <button className={`icon-button ${mode === "air"    ? "is-active" : ""}`} type="button"
            onClick={() => activate("air")}   title="가속도계"><Waves      size={18} /></button>
          <button className={`icon-button ${mode === "gyro"   ? "is-active" : ""}`} type="button"
            onClick={() => activate("gyro")}  title="자이로"><Compass     size={18} /></button>
          <button className={`icon-button ${mode === "fusion" ? "is-active" : ""}`} type="button"
            onClick={() => activate("fusion")} title="자이로+가속도 융합"><Combine   size={18} /></button>

          <button className={`icon-button ${tool === "brush"  ? "is-active" : ""}`} type="button"
            onClick={() => setTool("brush")}  title="브러시"><Brush  size={18} /></button>
          <button className={`icon-button ${tool === "eraser" ? "is-active" : ""}`} type="button"
            onClick={() => setTool("eraser")} title="지우개"><Eraser size={18} /></button>
          <button className="icon-button" type="button"
            onClick={() => socketRef.current?.emit("stroke:undo", { userId })} title="실행 취소">
            <Undo2 size={18} />
          </button>
        </div>
      </header>

      <section className="air-controls">
        {/* 색상 */}
        <div className="toolbar-group color-group">
          {DEFAULT_COLORS.map((sw) => (
            <button key={sw} className={`swatch ${color === sw ? "is-active" : ""}`}
              style={{ backgroundColor: sw }} type="button"
              onClick={() => { setColor(sw); setTool("brush"); }} />
          ))}
        </div>

        {/* 크기 */}
        <div className="toolbar-group size-group">
          <input aria-label="브러시 크기" className="size-slider"
            min={2} max={72} step={1} type="range" value={size}
            onChange={(e) => setSize(Number(e.target.value))} />
          <span className="air-size-label">{size}px</span>
        </div>

        {/* 모션 컨트롤 */}
        {isMotionMode && (
          <div className="air-motion-controls">

            {/* Air 전용 */}
            {showAccelControls && (
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

            {/* Gyro / Fusion 공통 */}
            {showGyroControls && (
              <>
                <label className="air-motion-control">
                  <span>Range °</span>
                  <input aria-label="자이로 범위" min={10} max={90} step={5} type="range"
                    value={gyroRange} onChange={(e) => setGyroRange(Number(e.target.value))} />
                  <output>{gyroRange}°</output>
                </label>
                <label className="air-motion-control">
                  <span>Smooth</span>
                  <input aria-label="스무딩" min={0} max={0.9} step={0.05} type="range"
                    value={gyroSmooth} onChange={(e) => setGyroSmooth(Number(e.target.value))} />
                  <output>{Math.round(gyroSmooth * 100)}%</output>
                </label>
              </>
            )}

            {/* Fusion 전용 */}
            {showFusionControls && (
              <>
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

            {/* 토글 그룹 */}
            <div className="air-flip-group">
              {/* Yaw: Gyro / Fusion 모드에서만 */}
              {showGyroControls && (
                <button
                  className={`air-toggle-button ${useYaw ? "is-active" : ""}`}
                  type="button"
                  onClick={() => { smoothRef.current = { alpha: 0, gamma: 0, beta: 0 }; setUseYaw((v) => !v); }}
                  title="손목 회전으로 좌우 조작"
                >
                  Yaw
                </button>
              )}
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
          onPointerUp={()     => { if (mode === "touch") setSpraying(false); }}
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
            <button className="icon-button" type="button" title="드리프트 초기화"
              onClick={() => { velRef.current = { x: 0, y: 0 }; gravityRef.current = { x: 0, y: 0 }; setMotionStatus("ready"); }}>
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
