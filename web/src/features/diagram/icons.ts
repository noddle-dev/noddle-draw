/**
 * features/diagram/icons — registry of glyphs for `icon`-kind diagram nodes.
 *
 * ⚠️ LICENSING: these are ORIGINAL, stylized geometric line-glyph PLACEHOLDERS
 * drawn in noddle's own style — they are NOT AWS / Databricks official icons and
 * intentionally do NOT reproduce any trademarked artwork. They only evoke the
 * service category (a chip, a bucket, a cylinder, stacked chevrons, …) so a
 * board reads at a glance. Swap for licensed icon sets before any real use.
 *
 * Pure data (no React/DOM). Each `motif` entry is a list of SVG path `d`
 * strings authored in a 0..24 coordinate box; the renderer (ShapePalette
 * `IconBadge`) scales that box into the node's glyph area and strokes the paths
 * in white on the accent-colored tile. `abbrev` labels the drag ghost.
 */

export type IconGroup = "aws" | "data" | "azure" | "network" | "gcp";

export interface IconDef {
  /** Registry key stored on the node as `iconKey`. */
  key: string;
  /** Human label (panel cell tooltip + default node caption). */
  label: string;
  group: IconGroup;
  /** Badge fill (a stylized, generic accent — not an official brand color). */
  accent: string;
  /** Short code shown on the drag ghost. */
  abbrev: string;
  /** White line-glyph paths in a 0..24 box. */
  motif: string[];
}

import { AWS_ICONS } from "./stencils/aws";
import { AZURE_ICONS } from "./stencils/azure";
import { GCP_ICONS } from "./stencils/gcp";

const INLINE_ICONS: Record<string, IconDef> = {
  // ---- AWS-style compute / storage / networking marks (stylized) ----
  "aws-ec2": {
    key: "aws-ec2",
    label: "EC2",
    group: "aws",
    accent: "#ED7100",
    abbrev: "EC2",
    // nested chip squares + pins
    motif: [
      "M6 8 H18 V18 H6 Z",
      "M9.5 11 H14.5 V15 H9.5 Z",
      "M10 8 V6 M14 8 V6 M10 18 V20 M14 18 V20",
    ],
  },
  "aws-s3": {
    key: "aws-s3",
    label: "S3",
    group: "aws",
    accent: "#7AA116",
    abbrev: "S3",
    // storage bucket
    motif: [
      "M5 8 A7 2 0 0 0 19 8 A7 2 0 0 0 5 8",
      "M5 8 L7.5 17.5 A4.5 1.6 0 0 0 16.5 17.5 L19 8",
    ],
  },
  "aws-lambda": {
    key: "aws-lambda",
    label: "Lambda",
    group: "aws",
    accent: "#ED7100",
    abbrev: "λ",
    // lambda glyph
    motif: ["M7 19 L13.5 6 L18 19", "M13.5 6 L10.5 12"],
  },
  "aws-rds": {
    key: "aws-rds",
    label: "RDS",
    group: "aws",
    accent: "#2E27AD",
    abbrev: "RDS",
    // database cylinder
    motif: [
      "M6 8 A6 2 0 0 0 18 8 A6 2 0 0 0 6 8",
      "M6 8 V16 A6 2 0 0 0 18 16 V8",
    ],
  },
  "aws-vpc": {
    key: "aws-vpc",
    label: "VPC",
    group: "aws",
    accent: "#8C4FFF",
    abbrev: "VPC",
    // nested hexagons (network boundary)
    motif: [
      "M12 5 L18 8.5 V15.5 L12 19 L6 15.5 V8.5 Z",
      "M12 9 L15 10.7 V14.3 L12 16 L9 14.3 V10.7 Z",
    ],
  },
  "aws-apigw": {
    key: "aws-apigw",
    label: "API Gateway",
    group: "aws",
    accent: "#E7157B",
    abbrev: "API",
    // hub with four spokes
    motif: [
      "M8 12 A4 4 0 0 1 16 12 A4 4 0 0 1 8 12",
      "M12 4 V8 M12 16 V20 M4 12 H8 M16 12 H20",
    ],
  },
  "aws-dynamodb": {
    key: "aws-dynamodb",
    label: "DynamoDB",
    group: "aws",
    accent: "#2E27AD",
    abbrev: "DDB",
    // table rows
    motif: ["M6 6 H18 V18 H6 Z", "M6 10 H18 M6 14 H18"],
  },
  "aws-cloudwatch": {
    key: "aws-cloudwatch",
    label: "CloudWatch",
    group: "aws",
    accent: "#E7157B",
    abbrev: "CW",
    // gauge with needle
    motif: ["M6 15 A6 6 0 0 1 18 15", "M6 15 H18", "M12 15 L15.5 10.5"],
  },

  // ---- Databricks / data-platform marks (stylized) ----
  "dbx-databricks": {
    key: "dbx-databricks",
    label: "Databricks",
    group: "data",
    accent: "#FF3621",
    abbrev: "DBX",
    // stacked chevrons (layered "bricks")
    motif: ["M6 9 L12 6 L18 9", "M6 12.5 L12 9.5 L18 12.5", "M6 16 L12 13 L18 16"],
  },
  "data-cluster": {
    key: "data-cluster",
    label: "Cluster",
    group: "data",
    accent: "#1B3139",
    abbrev: "CL",
    // three linked nodes
    motif: [
      "M8 9 L16 9 L12 16 Z",
      "M7 9 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0",
      "M15 9 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0",
      "M11 16 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0",
    ],
  },
  "data-notebook": {
    key: "data-notebook",
    label: "Notebook",
    group: "data",
    accent: "#EE6C4D",
    abbrev: "NB",
    // ruled notebook
    motif: ["M7 5 H17 V19 H7 Z", "M7 5 V19", "M10 9 H15 M10 12 H15 M10 15 H13"],
  },
  "data-delta": {
    key: "data-delta",
    label: "Delta",
    group: "data",
    accent: "#00A1C9",
    abbrev: "Δ",
    // delta triangle
    motif: ["M12 6 L18 18 H6 Z"],
  },

  // ---- Azure-style marks (stylized placeholders, same licensing note) ----
  "az-vm": {
    key: "az-vm",
    label: "Virtual Machine",
    group: "azure",
    accent: "#0078D4",
    abbrev: "VM",
    // monitor + stand
    motif: ["M5 6 H19 V15 H5 Z", "M10 15 L9 18 H15 L14 15", "M8 18 H16"],
  },
  "az-blob": {
    key: "az-blob",
    label: "Blob Storage",
    group: "azure",
    accent: "#0078D4",
    abbrev: "BLB",
    // box of blobs
    motif: [
      "M5 8 H19 V18 H5 Z",
      "M8 12 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0",
      "M13 14.5 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0",
    ],
  },
  "az-functions": {
    key: "az-functions",
    label: "Functions",
    group: "azure",
    accent: "#FFB900",
    abbrev: "FN",
    // lightning bolt
    motif: ["M13 4 L7 13 H11 L9.5 20 L17 10 H12.5 Z"],
  },
  "az-sql": {
    key: "az-sql",
    label: "SQL Database",
    group: "azure",
    accent: "#0078D4",
    abbrev: "SQL",
    motif: [
      "M6 7 A6 2 0 0 0 18 7 A6 2 0 0 0 6 7",
      "M6 7 V17 A6 2 0 0 0 18 17 V7",
      "M6 12 A6 2 0 0 0 18 12",
    ],
  },
  "az-aks": {
    key: "az-aks",
    label: "AKS",
    group: "azure",
    accent: "#326CE5",
    abbrev: "AKS",
    // helm-ish wheel
    motif: [
      "M12 4 L19 8 V16 L12 20 L5 16 V8 Z",
      "M12 9.5 a2.5 2.5 0 1 0 0 5 a2.5 2.5 0 1 0 0 -5",
      "M12 4 V9.5 M12 14.5 V20 M5 8 L9.8 11 M19 8 L14.2 11",
    ],
  },
  "az-keyvault": {
    key: "az-keyvault",
    label: "Key Vault",
    group: "azure",
    accent: "#0078D4",
    abbrev: "KV",
    // padlock
    motif: [
      "M8 11 V8.5 A4 4 0 0 1 16 8.5 V11",
      "M6.5 11 H17.5 V19 H6.5 Z",
      "M12 13.5 V16.5",
    ],
  },
  "az-servicebus": {
    key: "az-servicebus",
    label: "Service Bus",
    group: "azure",
    accent: "#0078D4",
    abbrev: "SB",
    // queue arrows
    motif: ["M5 9 H15 M12 6 L15 9 L12 12", "M19 15 H9 M12 12 L9 15 L12 18"],
  },

  // ---- network / infra marks ----
  "net-router": {
    key: "net-router",
    label: "Router",
    group: "network",
    accent: "#334155",
    abbrev: "RTR",
    // puck with crossing arrows
    motif: [
      "M4 12 a8 4 0 1 0 16 0 a8 4 0 1 0 -16 0",
      "M8 10.5 L11 12 L8 13.5 M16 10.5 L13 12 L16 13.5",
    ],
  },
  "net-switch": {
    key: "net-switch",
    label: "Switch",
    group: "network",
    accent: "#334155",
    abbrev: "SW",
    motif: ["M5 9 H19 V15 H5 Z", "M7.5 11 L9 12 L7.5 13 M11 11 L12.5 12 L11 13 M14.5 11 L16 12 L14.5 13"],
  },
  "net-firewall": {
    key: "net-firewall",
    label: "Firewall",
    group: "network",
    accent: "#DC2626",
    abbrev: "FW",
    // brick wall
    motif: ["M5 7 H19 V17 H5 Z", "M5 10.3 H19 M5 13.6 H19", "M9.5 7 V10.3 M14.5 7 V10.3 M12 10.3 V13.6 M8 13.6 V17 M16 13.6 V17"],
  },
  "net-lb": {
    key: "net-lb",
    label: "Load Balancer",
    group: "network",
    accent: "#0891B2",
    abbrev: "LB",
    // one-in, three-out
    motif: ["M5 12 H10", "M10 12 L17 7 M10 12 H17 M10 12 L17 17", "M17 6 a1 1 0 1 0 0 2 M17 11 a1 1 0 1 0 0 2 M17 16 a1 1 0 1 0 0 2"],
  },
  "net-server": {
    key: "net-server",
    label: "Server",
    group: "network",
    accent: "#334155",
    abbrev: "SRV",
    motif: ["M6 5 H18 V11 H6 Z", "M6 13 H18 V19 H6 Z", "M8 8 H10 M8 16 H10", "M15.5 8 a.6 .6 0 1 0 .01 0 M15.5 16 a.6 .6 0 1 0 .01 0"],
  },
  "net-internet": {
    key: "net-internet",
    label: "Internet",
    group: "network",
    accent: "#0369A1",
    abbrev: "NET",
    // globe
    motif: [
      "M12 4 a8 8 0 1 0 0 16 a8 8 0 1 0 0 -16",
      "M4 12 H20",
      "M12 4 a12 12 0 0 0 0 16 M12 4 a12 12 0 0 1 0 16",
    ],
  },
  "net-client": {
    key: "net-client",
    label: "Client",
    group: "network",
    accent: "#7C3AED",
    abbrev: "USR",
    // person
    motif: ["M12 6 a3 3 0 1 0 0 6 a3 3 0 1 0 0 -6", "M6 19 a6 5 0 0 1 12 0"],
  },
};

// Merge the per-provider stencil modules (aws/azure/gcp) over the inline set —
// a stencil entry wins on key collision; inline-only groups (data/network) stay.
export const ICONS: Record<string, IconDef> = {
  ...INLINE_ICONS,
  ...Object.fromEntries([...AWS_ICONS, ...AZURE_ICONS, ...GCP_ICONS].map((i) => [i.key, i])),
};

export function iconDef(key: string | undefined): IconDef | undefined {
  return key ? ICONS[key] : undefined;
}
