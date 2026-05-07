"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Combine, Crosshair, RefreshCw, Smartphone, Undo2 } from "lucide-react";
import { clamp, DEFAULT_COLORS, WALL_SIZE, generateId, type WallTool } from "@/lib/wall";

type AimPoint = { x: number; y: number };
type OrientPt = { alpha: number; gamma: number; beta: number };
type Mode     = "touch" | "fusion";

// ── 고정 센서 파라미터 (UI 노출 없음) ────────────────────────────
const GYRO_RANGE       = 45;    // 조준 범위 ±45°
const GYRO_SMOOTH      = 0.5;   // EMA 떨림 방지
const FUSION_BOOST     = 60;    // 가속도 오버레이 강도
const VEL_DECAY        = 0.60;  // 속도 감쇠
const MOTION_THRESHOLD = 0.3;   // 가속도 데드존
const GRAVITY_COEFF    = 0.8;
const USE_YAW          = true;  // X축: 손목 회전(alpha)
const FLIP_X           = true;
const FLIP_Y           = true;

const SEND_INTERVAL_MS = 33;
const CENTER_POINT: AimPoint = { x: WALL_SIZE.width / 2, y: WALL_SIZE.height / 2 };

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
  const socketRef        = useRef<Socket | null>(null);
  const surfaceRef       = useRef<HTMLDivElement | null>(null);
  const pointRef         = useRef<AimPoint>(CENTER_POINT);
  const sprayingRef      = useRef(false); // 윈도우 리스너와 동기 공유
  const velRef           = useRef({ x: 0, y: 0 });
  const gravityRef       = useRef({ x: 0, y: 0 });
  const zeroOrientRef    = useRef<OrientPt>({ alpha: 0, gamma: 0, beta: 0 });
  const currentOrientRef = useRef<OrientPt>({ alpha: 0, gamma: 0, beta: 0 });
  const smoothRef        = useRef<OrientPt>({ alpha: 0, gamma: 0, beta: 0 });

  const [connected,     setConnected]     = useState(false);
  const [color,         setColor]         = useState(DEFAULT_COLORS[0]);
  const [size,          setSize]          = useState(20);
  const [mode,          setMode]          = useState<Mode>("fusion");
  const [userId]                          = useState(() =>
    typeof window === "undefined" ? "loading" : getOrCreateAirUserId()
  );
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [motionStatus,  setMotionStatus]  = useState("off");
  const [aimPoint,      setAimPoint]      = useState<AimPoint>(CENTER_POINT);
  const [spraying,      setSpraying]      = useState(false);
  const [tool]                            = useState<WallTool>("brush");

  // ── Android: 마운트 시 자동 활성화 (iOS는 버튼 탭 필요) ────────
  useEffect(() => {
    const orientReq = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    if (typeof orientReq !== "function") {
      const timer = window.setTimeout(() => {
        setMotionEnabled(true);
        setMotionStatus("ready");
      }, 0);

      return () => window.clearTimeout(timer);
    }
  }, []);

  const indicatorStyle = useMemo(() => ({
    left: `${(aimPoint.x / WALL_SIZE.width)  * 100}%`,
    top:  `${(aimPoint.y / WALL_SIZE.height) * 100}%`,
    borderColor: color,
    boxShadow: spraying
      ? `0 0 0 6px ${color}50, 0 0 16px 4px ${color}40`
      : `0 0 0 4px ${color}28`,
  }), [aimPoint.x, aimPoint.y, color, spraying]);

  // ── Socket ─────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect",    () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  // ── Broadcast ──────────────────────────────────────────────────
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

  // ── 자이로 처리 ────────────────────────────────────────────────
  function applyOrientation(event: DeviceOrientationEvent, gotFirst: boolean): AimPoint {
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
    const s = GYRO_SMOOTH;
    smoothRef.current.alpha = s * smoothRef.current.alpha + (1 - s) * dAlpha;
    smoothRef.current.gamma = s * smoothRef.current.gamma + (1 - s) * dGamma;
    smoothRef.current.beta  = s * smoothRef.current.beta  + (1 - s) * dBeta;
    const dX = USE_YAW ? smoothRef.current.alpha : smoothRef.current.gamma;
    const dY = smoothRef.current.beta;
    return {
      x: clamp(WALL_SIZE.width  / 2 + (dX * (FLIP_X ? -1 : 1) * WALL_SIZE.width)  / (2 * GYRO_RANGE), 0, WALL_SIZE.width),
      y: clamp(WALL_SIZE.height / 2 + (dY * (FLIP_Y ? -1 : 1) * WALL_SIZE.height) / (2 * GYRO_RANGE), 0, WALL_SIZE.height),
    };
  }

  // ── 가속도 처리 ────────────────────────────────────────────────
  function applyAccel(event: DeviceMotionEvent, strength: number) {
    let ax: number, ay: number;
    if (event.acceleration?.x != null) {
      ax = event.acceleration.x ?? 0;
      ay = event.acceleration.y ?? 0;
    } else {
      const rx = event.accelerationIncludingGravity?.x ?? 0;
      const ry = event.accelerationIncludingGravity?.y ?? 0;
      gravityRef.current.x = GRAVITY_COEFF * gravityRef.current.x + (1 - GRAVITY_COEFF) * rx;
      gravityRef.current.y = GRAVITY_COEFF * gravityRef.current.y + (1 - GRAVITY_COEFF) * ry;
      ax = rx - gravityRef.current.x;
      ay = ry - gravityRef.current.y;
    }
    const fx = Math.abs(ax) > MOTION_THRESHOLD ? ax : 0;
    const fy = Math.abs(ay) > MOTION_THRESHOLD ? ay : 0;
    const dt = 0.016;
    velRef.current.x = velRef.current.x * VEL_DECAY + fx   * (FLIP_X ? -1 : 1) * strength * dt;
    velRef.current.y = velRef.current.y * VEL_DECAY + (-fy) * (FLIP_Y ? -1 : 1) * strength * dt;
  }

  // ── 센서 모드 (자이로 + 가속도 Fusion) ───────────────────────
  useEffect(() => {
    if (mode !== "fusion" || !motionEnabled) return;
    let got = false;
    const onMotion = (e: DeviceMotionEvent) => { applyAccel(e, FUSION_BOOST); };
    const onOrient = (e: DeviceOrientationEvent) => {
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
  }, [mode, motionEnabled]);

  const isSensor = mode === "fusion";

  // ── 센서 모드: 윈도우 레벨 드래그 추적 ───────────────────────
  //    pointermove + touchmove 둘 다 처리해 iOS/Android 호환
  useEffect(() => {
    if (!isSensor) return;

    const calcSize = (clientY: number) => {
      if (!sprayingRef.current) return;
      const el = surfaceRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const t = clamp((clientY - r.top) / r.height, 0, 1);
      setSize(Math.round(4 + t * 68));
    };

    const onPointerMove = (e: PointerEvent) => calcSize(e.clientY);
    const onTouchMove   = (e: TouchEvent)   => { if (e.touches.length) calcSize(e.touches[0].clientY); };
    const stopSpray     = () => { sprayingRef.current = false; setSpraying(false); };

    window.addEventListener("pointermove",   onPointerMove);
    window.addEventListener("touchmove",     onTouchMove, { passive: true });
    window.addEventListener("pointerup",     stopSpray);
    window.addEventListener("pointercancel", stopSpray);
    window.addEventListener("touchend",      stopSpray);
    window.addEventListener("touchcancel",   stopSpray);

    return () => {
      window.removeEventListener("pointermove",   onPointerMove);
      window.removeEventListener("touchmove",     onTouchMove);
      window.removeEventListener("pointerup",     stopSpray);
      window.removeEventListener("pointercancel", stopSpray);
      window.removeEventListener("touchend",      stopSpray);
      window.removeEventListener("touchcancel",   stopSpray);
    };
  }, [isSensor]);

  // ── 터치 위치 (touch 모드) ─────────────────────────────────────
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

  // ── 모드 전환 ──────────────────────────────────────────────────
  function resetRefs() {
    velRef.current        = { x: 0, y: 0 };
    gravityRef.current    = { x: 0, y: 0 };
    zeroOrientRef.current = { alpha: 0, gamma: 0, beta: 0 };
    smoothRef.current     = { alpha: 0, gamma: 0, beta: 0 };
  }

  async function switchToFusion() {
    resetRefs();
    setMode("fusion");
    setMotionStatus("ready");
    const ok = await requestSensorPermission();
    setMotionEnabled(ok);
    setMotionStatus(ok ? "ready" : "denied");
  }

  function switchToTouch() {
    setMode("touch");
    setMotionEnabled(false);
    setMotionStatus("off");
    resetRefs();
  }

  // ── 재조준 ────────────────────────────────────────────────────
  function recenter() {
    zeroOrientRef.current = { ...currentOrientRef.current };
    smoothRef.current     = { alpha: 0, gamma: 0, beta: 0 };
    velRef.current        = { x: 0, y: 0 };
    pointRef.current      = CENTER_POINT;
    setAimPoint(CENTER_POINT);
  }

  return (
    <main className="air-shell" onContextMenu={(e) => e.preventDefault()}>
      <header className="air-header">
        <div className="air-title">
          <p className="eyebrow">Air Spray</p>
          <div className="air-status">
            <span className={connected ? "status-dot is-online" : "status-dot"} />
            <span className="air-status-text">
              {connected ? "live" : "offline"}
              {isSensor && ` · ${motionStatus}`}
            </span>
          </div>
        </div>

        <div className="toolbar-group">
          <button
            className={`icon-button ${!isSensor ? "is-active" : ""}`}
            type="button"
            onClick={switchToTouch}
            title="터치 모드"
          >
            <Smartphone size={18} />
          </button>
          <button
            className={`icon-button ${isSensor ? "is-active" : ""}`}
            type="button"
            onClick={switchToFusion}
            title="센서 모드"
          >
            <Combine size={18} />
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
        {/* 색상 팔렛트 — 1줄 고정 */}
        <div className="toolbar-group air-color-row">
          {DEFAULT_COLORS.map((sw) => (
            <button
              key={sw}
              className={`swatch ${color === sw ? "is-active" : ""}`}
              style={{ backgroundColor: sw }}
              type="button"
              onClick={() => setColor(sw)}
            />
          ))}
        </div>

        {/* 굵기 슬라이더 — 터치 모드에서만 */}
        {!isSensor && (
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
        )}
      </section>

      <section className="air-stage">
        {/* 트랙패드 */}
        <div
          ref={surfaceRef}
          className={`air-surface${isSensor ? " air-surface--sensor" : ""}${spraying ? " is-spraying" : ""}`}
          onPointerDown={(e) => {
            if (isSensor) {
              sprayingRef.current = true;
              setSpraying(true);
              // 초기 굵기 설정
              const r = e.currentTarget.getBoundingClientRect();
              const t = clamp((e.clientY - r.top) / r.height, 0, 1);
              setSize(Math.round(4 + t * 68));
            } else {
              setPointFromTouch(e.clientX, e.clientY);
              setSpraying(true);
            }
          }}
          onPointerMove={(e) => {
            // 센서 모드 이동: 윈도우 리스너가 처리
            if (!isSensor && e.buttons === 1) {
              setPointFromTouch(e.clientX, e.clientY);
            }
          }}
          onPointerUp={() => { if (!isSensor) setSpraying(false); }}
          onPointerCancel={() => { if (!isSensor) setSpraying(false); }}
        >
          <span className={`air-indicator${spraying ? " is-spraying" : ""}`} style={indicatorStyle} />
        </div>

        {/* 하단 액션 */}
        <div className="air-actions">
          <button
            className="icon-button"
            type="button"
            onClick={recenter}
            title="재조준"
          >
            <Crosshair size={18} />
          </button>
          {isSensor && (
            <button
              className="icon-button"
              type="button"
              onClick={() => {
                velRef.current     = { x: 0, y: 0 };
                gravityRef.current = { x: 0, y: 0 };
                setMotionStatus("ready");
              }}
              title="드리프트 초기화"
            >
              <RefreshCw size={18} />
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
