/** shared/ui/Panel — left/right sidebar container (maps to .panel tokens). */
import type { ReactNode } from "react";

interface PanelProps {
  side: "left" | "right";
  children: ReactNode;
}

export function Panel({ side, children }: PanelProps) {
  return <aside className={`panel ${side}`}>{children}</aside>;
}

/** Section heading used inside panels (maps to .panel h3). */
export function PanelSection({ title }: { title: string }) {
  return <h3>{title}</h3>;
}
