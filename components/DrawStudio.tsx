"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Brush, ChevronDown, ChevronUp, Circle, Eraser, Minus, Plus, Undo2 } from "lucide-react";
import { DEFAULT_COLORS, generateId, type WallStats, type WallTool } from "@/lib/wall";
import { GraffitiWall, type GraffitiWallHandle } from "@/components/GraffitiWall";

function getOrCreateUserId() {
  const saved = window.localStorage.getItem("wall-user-id");
  if (saved) return saved;
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
  const [stats, setStats] = useState<WallStats>({ onlineCount: 0, strokeCount: 0 });
  const [userId, setUserId] = useState("loading");
  const [isMobile, setIsMobile] = useState(false);
  const [toolbarOpen, setToolbarOpen] = useState(false);

  useEffect(() => {
    setUserId(getOrCreateUserId());
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 680px)");
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) setToolbarOpen(false);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const toolbarExpanded = !isMobile || toolbarOpen;

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

      <section
        className={`paint-toolbar ${isMobile ? "is-mobile" : ""} ${toolbarOpen ? "is-open" : ""}`}
        aria-label="Drawing tools"
      >
        {/* Mobile collapsed bar */}
        {isMobile && (
          <div className="toolbar-compact">
            <div className="toolbar-group">
              <button
                className={`icon-button ${tool === "brush" ? "is-active" : ""}`}
                type="button"
                onClick={() => setTool("brush")}
              >
                <Brush size={20} />
              </button>
              <button
                className={`icon-button ${tool === "eraser" ? "is-active" : ""}`}
                type="button"
                onClick={() => setTool("eraser")}
              >
                <Eraser size={20} />
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={() => wallRef.current?.undo()}
              >
                <Undo2 size={20} />
              </button>
              <span
                className="compact-color"
                style={{ backgroundColor: color }}
              />
            </div>
            <div className="toolbar-group">
              <span className={connected ? "status-dot is-online" : "status-dot"} />
              <button
                className="icon-button"
                type="button"
                onClick={() => setToolbarOpen((v) => !v)}
                aria-label={toolbarOpen ? "Collapse toolbar" : "Expand toolbar"}
              >
                {toolbarOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              </button>
            </div>
          </div>
        )}

        {/* Full controls */}
        <div className={`toolbar-full ${toolbarExpanded ? "is-visible" : ""}`}>
          {!isMobile && (
            <div className="toolbar-group">
              <button
                className={`icon-button ${tool === "brush" ? "is-active" : ""}`}
                type="button"
                aria-label="Brush"
                onClick={() => setTool("brush")}
              >
                <Brush size={22} />
              </button>
              <button
                className={`icon-button ${tool === "eraser" ? "is-active" : ""}`}
                type="button"
                aria-label="Eraser"
                onClick={() => setTool("eraser")}
              >
                <Eraser size={22} />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Undo"
                onClick={() => wallRef.current?.undo()}
              >
                <Undo2 size={22} />
              </button>
            </div>
          )}

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
            <label className="color-picker" title="Custom color">
              <Circle size={18} />
              <input
                aria-label="Custom color"
                type="color"
                value={color}
                onChange={(e) => { setColor(e.target.value); setTool("brush"); }}
              />
            </label>
          </div>

          <div className="toolbar-group size-group">
            <button
              className="icon-button"
              type="button"
              onClick={() => setSize((v) => Math.max(2, v - 4))}
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
              onChange={(e) => setSize(Number(e.target.value))}
            />
            <button
              className="icon-button"
              type="button"
              onClick={() => setSize((v) => Math.min(72, v + 4))}
            >
              <Plus size={20} />
            </button>
            <span className="brush-preview" style={{ "--brush-size": `${size}px` } as CSSProperties} />
          </div>

          {!isMobile && (
            <div className="toolbar-status">
              <span className={connected ? "status-dot is-online" : "status-dot"} />
              <span>{connected ? "Live" : "Offline"}</span>
              <span>{stats.onlineCount}</span>
              <span>{stats.strokeCount}</span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
