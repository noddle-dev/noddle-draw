/**
 * features/diagram/stencils/gcp — Google Cloud stencil glyphs (ORIGINAL
 * stylized line-art placeholders, NOT trademarked artwork — see icons.ts).
 *
 * Motifs are authored in a 0..24 box (2px safe margin), stroke-only —
 * rendered as white 1.9px strokes on the accent tile.
 */
import type { IconDef } from "../icons";

export const GCP_ICONS: IconDef[] = [
  {
    key: "gcp-gce",
    label: "Compute Engine",
    group: "gcp",
    accent: "#4285f4",
    abbrev: "GCE",
    motif: [
      "M5 5 h14 v14 h-14 Z",
      "M9.5 9.5 h5 v5 h-5 Z",
      "M9 2 v3 M15 2 v3 M9 19 v3 M15 19 v3",
      "M2 9 h3 M2 15 h3 M19 9 h3 M19 15 h3",
    ],
  },
  {
    key: "gcp-gke",
    label: "Kubernetes Engine",
    group: "gcp",
    accent: "#4285f4",
    abbrev: "GKE",
    motif: [
      "M5 12 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0",
      "M9.5 12 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0",
      "M14.5 12 L19 12 M9.5 12 L5 12",
      "M13.3 9.8 L15.5 5.9 M10.8 9.8 L8.5 5.9",
      "M10.8 14.2 L8.5 18.1 M13.3 14.2 L15.5 18.1",
    ],
  },
  {
    key: "gcp-run",
    label: "Cloud Run",
    group: "gcp",
    accent: "#4285f4",
    abbrev: "RUN",
    motif: [
      "M3 12 a9 9 0 1 0 18 0 a9 9 0 1 0 -18 0",
      "M10 8.5 L16 12 L10 15.5 Z",
    ],
  },
  {
    key: "gcp-func",
    label: "Cloud Functions",
    group: "gcp",
    accent: "#4285f4",
    abbrev: "FN",
    motif: [
      "M14.5 4 a3 3 0 0 0 -3 3 v10 a3 3 0 0 1 -3 3",
      "M8.5 10.5 h6",
    ],
  },
  {
    key: "gcp-gcs",
    label: "Cloud Storage",
    group: "gcp",
    accent: "#34a853",
    abbrev: "GCS",
    motif: [
      "M4 6 h16 v5 h-16 Z",
      "M4 13 h16 v5 h-16 Z",
      "M10 8.5 h4",
      "M10 15.5 h4",
    ],
  },
  {
    key: "gcp-bq",
    label: "BigQuery",
    group: "gcp",
    accent: "#f9ab00",
    abbrev: "BQ",
    motif: [
      "M4.5 10.5 a6.5 6.5 0 1 0 13 0 a6.5 6.5 0 1 0 -13 0",
      "M15.6 15.1 L20 19.5",
      "M8.5 13 v-2.5 M11 13 v-5 M13.5 13 v-3.5",
    ],
  },
  {
    key: "gcp-sql",
    label: "Cloud SQL",
    group: "gcp",
    accent: "#34a853",
    abbrev: "SQL",
    motif: [
      "M6 6 a6 2.5 0 1 0 12 0 a6 2.5 0 1 0 -12 0",
      "M6 6 v12 M18 6 v12",
      "M6 12 a6 2.5 0 0 0 12 0",
      "M6 18 a6 2.5 0 0 0 12 0",
    ],
  },
  {
    key: "gcp-firestore",
    label: "Firestore",
    group: "gcp",
    accent: "#34a853",
    abbrev: "FS",
    motif: [
      "M6 3 h9 l3 3 v15 h-12 Z",
      "M15 3 v3 h3",
      "M9 12 h6 M9 16 h6",
    ],
  },
  {
    key: "gcp-pubsub",
    label: "Pub/Sub",
    group: "gcp",
    accent: "#f9ab00",
    abbrev: "PS",
    motif: [
      "M10 12 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
      "M3.5 5.5 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
      "M16.5 5.5 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
      "M10 19.5 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
      "M10.6 10.6 L6.9 6.9 M13.4 10.6 L17.1 6.9 M12 14 v3.5",
    ],
  },
  {
    key: "gcp-dataflow",
    label: "Dataflow",
    group: "gcp",
    accent: "#f9ab00",
    abbrev: "FLOW",
    motif: [
      "M5.5 12 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0",
      "M13.5 12 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0",
      "M2 12 h3.5 M10.5 12 h3 M18.5 12 h3.5",
    ],
  },
  {
    key: "gcp-vertex",
    label: "Vertex AI",
    group: "gcp",
    accent: "#f9ab00",
    abbrev: "VRTX",
    motif: [
      "M12 3 L13.8 10.2 L21 12 L13.8 13.8 L12 21 L10.2 13.8 L3 12 L10.2 10.2 Z",
    ],
  },
  {
    key: "gcp-armor",
    label: "Cloud Armor",
    group: "gcp",
    accent: "#ea4335",
    abbrev: "ARM",
    motif: [
      "M12 3 L20 6 v6 c0 5 -3.5 8 -8 9 c-4.5 -1 -8 -4 -8 -9 v-6 Z",
      "M8.5 12 l2.5 2.5 l4.5 -5",
    ],
  },
  {
    key: "gcp-lb",
    label: "Load Balancing",
    group: "gcp",
    accent: "#ea4335",
    abbrev: "LB",
    motif: [
      "M9.5 4.5 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0",
      "M12 7 v4 M12 11 L5 16 M12 11 v5 M12 11 L19 16",
      "M3 19 h4 M10 19 h4 M17 19 h4",
    ],
  },
  {
    key: "gcp-vpc",
    label: "VPC",
    group: "gcp",
    accent: "#ea4335",
    abbrev: "VPC",
    motif: [
      "M3 8 v-5 h5",
      "M16 3 h5 v5",
      "M21 16 v5 h-5",
      "M8 21 h-5 v-5",
      "M10 12 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
      "M7 17 L10.6 13.4 M17 7 L13.4 10.6",
    ],
  },
  {
    key: "gcp-iam",
    label: "IAM",
    group: "gcp",
    accent: "#ea4335",
    abbrev: "IAM",
    motif: [
      "M9.5 7 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0",
      "M5 19 a7 5 0 0 1 14 0",
      "M15.5 15 l2 2 l3.5 -4",
    ],
  },
  {
    key: "gcp-spanner",
    label: "Spanner",
    group: "gcp",
    accent: "#34a853",
    abbrev: "SPAN",
    motif: [
      "M3 12 a9 9 0 1 0 18 0 a9 9 0 1 0 -18 0",
      "M3 12 h18",
      "M12 3 a4.5 9 0 1 0 0 18 a4.5 9 0 1 0 0 -18",
    ],
  },
];
