"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  Brush,
  Circle,
  Eraser,
  Minus,
  Plus,
  Undo2
} from "lucide-react";
import {
  DEFAULT_COLORS,
  generateId,
  type WallStats,
  type WallTool
} from "@/lib/wall";
import {
  GraffitiWall,
  type GraffitiWallHandle
} from "@/components/GraffitiWall";

function getOrCreateUserId() {
  const saved = window.localStorage.getItem("wall-user-id");
  if (saved) {
    return saved;
  }

  const next = generateId();
  window.localStorage.setItem("wall-user-id", next);
  return next;
}

export function DrawStudio() {
  const wallRef = useRef<GraffitiWallHandle | null>(null);
  const [tool, setTool] = useState<WallTool>("brush");
  const [color, setColor] = useState(DEFAULT_COLORS[0]);
  const [size, setSize] = useState(18);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<WallStats>({
    onlineCount: 0,
    strokeCount: 0
  });
  const [userId, setUserId] = useState("loading");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setUserId(getOrCreateUserId());
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="draw-shell">
      <GraffitiWall
        ref={wallRef}
        color={color}
        interactive
        onConnectionChange={setConnected}
        onStatsChange={setStats}
        size={size}
        tool={tool}
        userId={userId}
        variant="draw"
      />

      <section className="paint-toolbar" aria-label="Drawing tools">
        <div className="toolbar-group">
          <button
            className={`icon-button ${tool === "brush" ? "is-active" : ""}`}
            type="button"
            aria-label="Brush"
            title="Brush"
            onClick={() => setTool("brush")}
          >
            <Brush size={22} />
          </button>
          <button
            className={`icon-button ${tool === "eraser" ? "is-active" : ""}`}
            type="button"
            aria-label="Eraser"
            title="Eraser"
            onClick={() => setTool("eraser")}
          >
            <Eraser size={22} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Undo"
            title="Undo"
            onClick={() => wallRef.current?.undo()}
          >
            <Undo2 size={22} />
          </button>
        </div>

        <div className="toolbar-group color-group">
          {DEFAULT_COLORS.map((swatch) => (
            <button
              key={swatch}
              className={`swatch ${color === swatch ? "is-active" : ""}`}
              style={{ backgroundColor: swatch }}
              type="button"
              aria-label={`Color ${swatch}`}
              title={swatch}
              onClick={() => {
                setColor(swatch);
                setTool("brush");
              }}
            />
          ))}
          <label className="color-picker" title="Custom color">
            <Circle size={18} />
            <input
              aria-label="Custom color"
              type="color"
              value={color}
              onChange={(event) => {
                setColor(event.target.value);
                setTool("brush");
              }}
            />
          </label>
        </div>

        <div className="toolbar-group size-group">
          <button
            className="icon-button"
            type="button"
            aria-label="Smaller brush"
            title="Smaller"
            onClick={() => setSize((value) => Math.max(2, value - 4))}
          >
            <Minus size={20} />
          </button>
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
          <button
            className="icon-button"
            type="button"
            aria-label="Larger brush"
            title="Larger"
            onClick={() => setSize((value) => Math.min(72, value + 4))}
          >
            <Plus size={20} />
          </button>
          <span
            className="brush-preview"
            style={{ "--brush-size": `${size}px` } as CSSProperties}
          />
        </div>

        <div className="toolbar-status">
          <span className={connected ? "status-dot is-online" : "status-dot"} />
          <span>{connected ? "Live" : "Offline"}</span>
          <span>{stats.onlineCount}</span>
          <span>{stats.strokeCount}</span>
        </div>
      </section>
    </main>
  );
}
