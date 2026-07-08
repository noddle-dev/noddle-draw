/**
 * features/diagram/stencils/azure — Azure stencil glyphs (ORIGINAL stylized
 * line-art placeholders, NOT trademarked artwork — see icons.ts header).
 */
import type { IconDef } from "../icons";

export const AZURE_ICONS: IconDef[] = [
  // ---- existing set (moved verbatim from icons.ts) ----
  {
    key: "az-vm",
    label: "Virtual Machine",
    group: "azure",
    accent: "#0078D4",
    abbrev: "VM",
    // monitor + stand
    motif: ["M5 6 H19 V15 H5 Z", "M10 15 L9 18 H15 L14 15", "M8 18 H16"],
  },
  {
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
  {
    key: "az-functions",
    label: "Functions",
    group: "azure",
    accent: "#FFB900",
    abbrev: "FN",
    // lightning bolt
    motif: ["M13 4 L7 13 H11 L9.5 20 L17 10 H12.5 Z"],
  },
  {
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
  {
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
  {
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
  {
    key: "az-servicebus",
    label: "Service Bus",
    group: "azure",
    accent: "#0078D4",
    abbrev: "SB",
    // queue arrows
    motif: ["M5 9 H15 M12 6 L15 9 L12 12", "M19 15 H9 M12 12 L9 15 L12 18"],
  },

  // ---- new entries (same licensing note: original stylized motifs) ----
  {
    key: "az-appsvc",
    label: "App Service",
    group: "azure",
    accent: "#0078D4",
    abbrev: "APP",
    // globe: circle + equator + meridian ellipse
    motif: [
      "M12 5 a7 7 0 1 0 0 14 a7 7 0 1 0 0 -14",
      "M5 12 H19",
      "M12 5 a4 7 0 1 0 0 14 a4 7 0 1 0 0 -14",
    ],
  },
  {
    key: "az-cosmos",
    label: "Cosmos DB",
    group: "azure",
    accent: "#326CE5",
    abbrev: "COS",
    // planet with orbit ring
    motif: [
      "M12 7.5 a4.5 4.5 0 1 0 0 9 a4.5 4.5 0 1 0 0 -9",
      "M3 12 a9 3.5 0 1 0 18 0 a9 3.5 0 1 0 -18 0",
    ],
  },
  {
    key: "az-storage",
    label: "Storage Account",
    group: "azure",
    accent: "#0078D4",
    abbrev: "STG",
    // drawer stack with handles
    motif: [
      "M4 7 H20 V17 H4 Z",
      "M4 10.3 H20 M4 13.6 H20",
      "M6.5 8.6 H9.5 M6.5 11.9 H9.5 M6.5 15.2 H9.5",
    ],
  },
  {
    key: "az-eventhub",
    label: "Event Hub",
    group: "azure",
    accent: "#0078D4",
    abbrev: "EH",
    // hub node with fan-out rays
    motif: [
      "M5.5 12 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0",
      "M10.5 12 H20",
      "M10.2 10.9 L19.5 6.5",
      "M10.2 13.1 L19.5 17.5",
    ],
  },
  {
    key: "az-monitor",
    label: "Monitor",
    group: "azure",
    accent: "#326CE5",
    abbrev: "MON",
    // heartbeat pulse line
    motif: ["M3 13 H8 L10.5 7 L13.5 17 L16 13 H21"],
  },
  {
    key: "az-frontdoor",
    label: "Front Door",
    group: "azure",
    accent: "#0078D4",
    abbrev: "FD",
    // doorway arch + entering arrow
    motif: [
      "M6 20 V10 A6 6 0 0 1 18 10 V20",
      "M4 20 H20",
      "M2.5 14.5 H11.5 M9 12 L11.5 14.5 L9 17",
    ],
  },
  {
    key: "az-apim",
    label: "API Management",
    group: "azure",
    accent: "#326CE5",
    abbrev: "APIM",
    // code brackets + slash
    motif: ["M8 7 L3.5 12 L8 17", "M16 7 L20.5 12 L16 17", "M13.7 6 L10.3 18"],
  },
  {
    key: "az-entra",
    label: "Entra ID",
    group: "azure",
    accent: "#0078D4",
    abbrev: "ID",
    // shield with person (identity)
    motif: [
      "M12 3.5 L19 6 V11.5 C19 16 16 19.3 12 20.8 C8 19.3 5 16 5 11.5 V6 Z",
      "M12 8.5 a2 2 0 1 0 0 4 a2 2 0 1 0 0 -4",
      "M8.5 17 A3.5 3.2 0 0 1 15.5 17",
    ],
  },
  {
    key: "az-vnet",
    label: "Virtual Network",
    group: "azure",
    accent: "#326CE5",
    abbrev: "VNET",
    // four-node mesh
    motif: [
      "M5.4 7 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0",
      "M15.4 7 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0",
      "M5.4 17 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0",
      "M15.4 17 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0",
      "M8.1 8.1 L15.9 15.9 M15.9 8.1 L8.1 15.9 M8.6 7 H15.4 M8.6 17 H15.4 M7 8.6 V15.4 M17 8.6 V15.4",
    ],
  },
];
