"use client";

import { useRef, useState } from "react";
import { RotateCcw, ShieldCheck } from "lucide-react";
import { type WallStats } from "@/lib/wall";
import {
  GraffitiWall,
  type GraffitiWallHandle
} from "@/components/GraffitiWall";

export function AdminPanel() {
  const wallRef = useRef<GraffitiWallHandle | null>(null);
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("");
  const [stats, setStats] = useState<WallStats>({
    onlineCount: 0,
    strokeCount: 0
  });

  async function resetWall() {
    setMessage("");
    const ok = await wallRef.current?.reset(pin);
    setMessage(ok ? "Reset complete" : "Reset blocked");
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Wall Admin</p>
          <h1>Control Room</h1>
        </div>
        <div className="admin-stats">
          <span>{stats.onlineCount} online</span>
          <span>{stats.strokeCount} marks</span>
        </div>
      </header>

      <section className="admin-actions" aria-label="Wall controls">
        <label className="pin-field">
          <ShieldCheck size={18} />
          <input
            autoComplete="off"
            placeholder="ADMIN_PIN"
            type="password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
          />
        </label>
        <button className="danger-button" type="button" onClick={resetWall}>
          <RotateCcw size={18} />
          Reset Wall
        </button>
        {message ? <span className="admin-message">{message}</span> : null}
      </section>

      <GraffitiWall
        ref={wallRef}
        color="#f8fafc"
        onStatsChange={setStats}
        size={18}
        tool="brush"
        userId="admin"
        variant="admin"
      />
    </main>
  );
}
