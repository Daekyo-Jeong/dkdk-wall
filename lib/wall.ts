export const WALL_SIZE = {
  width: 4320,
  height: 1920
} as const;

export type WallTool = "brush" | "eraser";

export type Point = {
  x: number;
  y: number;
};

export type Stroke = {
  id: string;
  userId: string;
  tool: WallTool;
  color: string;
  size: number;
  points: Point[];
  createdAt: number;
};

export type WallStats = {
  strokeCount: number;
  onlineCount: number;
};

export const DEFAULT_COLORS = [
  "#f8fafc",
  "#111827",
  "#ef4444",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
  "#ec4899"
];

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
