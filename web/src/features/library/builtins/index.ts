/**
 * features/library/builtins — the built-in shape libraries (static content).
 * Authored with the helpers in ./_kit; one file per pack, one dominant hue each.
 */
import type { LibraryPack } from "../types";
import { AWS_PACK, AZURE_PACK, GCP_PACK } from "./cloud";
import { ARCHITECTURE_PACK } from "./architecture";
import { BRAINSTORM_PACK } from "./brainstorm";
import { CALLOUTS_PACK } from "./callouts";
import { CHARTS_PACK } from "./charts";
import { DATABASE_PACK } from "./database";
import { FLOWCHART_PACK } from "./flowchart";
import { PEOPLE_PACK } from "./people";
import { STRATEGY_PACK } from "./strategy";
import { WIREFRAME_MOBILE_PACK } from "./wireframe-mobile";
import { WIREFRAME_WEB_PACK } from "./wireframe-web";

export const BUILTIN_PACKS: LibraryPack[] = [
  FLOWCHART_PACK,
  ARCHITECTURE_PACK,
  WIREFRAME_WEB_PACK,
  WIREFRAME_MOBILE_PACK,
  PEOPLE_PACK,
  CALLOUTS_PACK,
  BRAINSTORM_PACK,
  CHARTS_PACK,
  DATABASE_PACK,
  STRATEGY_PACK,
  AWS_PACK,
  AZURE_PACK,
  GCP_PACK,
];

/** Top-level shelves (the panel's tab row) — every pack sits on exactly one.
 * `short` is the chip label (the full name stays the section title). */
export const LIBRARY_SHELVES: { id: string; label: string; packs: { id: string; short: string }[] }[] = [
  {
    id: "diagrams",
    label: "Diagrams",
    packs: [
      { id: "flowchart", short: "Flowchart" },
      { id: "architecture", short: "Architecture" },
      { id: "database", short: "ERD" },
      { id: "charts", short: "Charts" },
      { id: "strategy", short: "Strategy" },
      { id: "brainstorm", short: "Brainstorm" },
      { id: "callouts", short: "Callouts" },
      { id: "people", short: "People" },
    ],
  },
  {
    id: "wireframes",
    label: "Wireframes",
    packs: [
      { id: "wireframe-web", short: "Web" },
      { id: "wireframe-mobile", short: "Mobile" },
    ],
  },
  {
    id: "cloud",
    label: "Cloud",
    packs: [
      { id: "aws", short: "AWS" },
      { id: "azure", short: "Azure" },
      { id: "gcp", short: "Google Cloud" },
    ],
  },
];
