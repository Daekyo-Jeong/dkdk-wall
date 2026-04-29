"use client";

import { useState } from "react";
import { type WallStats } from "@/lib/wall";
import { GraffitiWall } from "@/components/GraffitiWall";

export function WallDisplay() {
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<WallStats>({
    onlineCount: 0,
    strokeCount: 0
  });
  const drawUrl = "/draw";

  return (
    <main className="display-shell">
      <GraffitiWall
        color="#f8fafc"
        onConnectionChange={setConnected}
        onStatsChange={setStats}
        size={18}
        tool="brush"
        userId="display"
        variant="display"
      />
      <div className="wall-hud">
        <span className={connected ? "status-dot is-online" : "status-dot"} />
        <span>{stats.onlineCount} online</span>
        <span>{stats.strokeCount} marks</span>
        <span>{drawUrl}</span>
      </div>
    </main>
  );
}
