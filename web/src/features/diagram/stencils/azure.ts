/**
 * features/diagram/stencils/azure — Azure stencil glyphs.
 *
 * ⚠️ LICENSING: ORIGINAL pictograms drawn for noddle — NOT Microsoft artwork and
 * no official path data. They only borrow the general *style language* of the
 * Azure architecture icon family (flat filled shapes, vertical blue gradients,
 * 2–3 tone layering, white highlight sub-shapes) so an Azure board reads at a
 * glance next to Lucid-style libraries. Swap for licensed icons before any
 * real use.
 *
 * Style "glyph" (no tile). Every glyph is authored in the 0..24 box and fills
 * roughly 1.5..22.5 (≈88%) so the set keeps one optical size.
 */
import type { IconDef, IconPart } from "../icons";

// ---- palette -------------------------------------------------------------
const BLUE: [string, string] = ["#5EA0EF", "#0078D4"]; // primary body
const CYAN: [string, string] = ["#32BEDD", "#0078D4"]; // secondary body
const DEEP = "#005BA1"; // shade / back faces
const MID = "#1490DF";
const LIGHT = "#50E6FF"; // accent
const PALE = "#C3F1FF"; // highlight tint
const WHITE = "#FFFFFF";
const PURPLE: [string, string] = ["#B77AF4", "#773ADC"];
const GREEN: [string, string] = ["#86D633", "#5E9624"];
const AMBER: [string, string] = ["#FFD70F", "#FF8C00"];
const RED: [string, string] = ["#F25C5C", "#C81E1E"];
const TEAL: [string, string] = ["#4ADBD0", "#0E8A92"];
const GREY: [string, string] = ["#B3B3B3", "#767676"];

// ---- path helpers (pure strings in the 0..24 box) -------------------------
const n = (v: number) => +v.toFixed(2);
/** Circle (clockwise). */
const circ = (cx: number, cy: number, r: number) =>
  `M${n(cx - r)} ${n(cy)} a${r} ${r} 0 1 1 ${n(2 * r)} 0 a${r} ${r} 0 1 1 ${n(-2 * r)} 0Z`;
/** Circle drawn counter-clockwise — appended to a clockwise shape it punches a hole. */
const hole = (cx: number, cy: number, r: number) =>
  `M${n(cx - r)} ${n(cy)} a${r} ${r} 0 1 0 ${n(2 * r)} 0 a${r} ${r} 0 1 0 ${n(-2 * r)} 0Z`;
const ell = (cx: number, cy: number, rx: number, ry: number) =>
  `M${n(cx - rx)} ${n(cy)} a${rx} ${ry} 0 1 1 ${n(2 * rx)} 0 a${rx} ${ry} 0 1 1 ${n(-2 * rx)} 0Z`;
/** Rounded rectangle. */
const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${n(x + r)} ${n(y)} H${n(x + w - r)} a${r} ${r} 0 0 1 ${r} ${r} V${n(y + h - r)} a${r} ${r} 0 0 1 ${-r} ${r}` +
  ` H${n(x + r)} a${r} ${r} 0 0 1 ${-r} ${-r} V${n(y + r)} a${r} ${r} 0 0 1 ${r} ${-r}Z`;
/** Rounded only on the top corners (title bars, lids). */
const rrTop = (x: number, y: number, w: number, h: number, r: number) =>
  `M${n(x)} ${n(y + h)} V${n(y + r)} a${r} ${r} 0 0 1 ${r} ${-r} H${n(x + w - r)} a${r} ${r} 0 0 1 ${r} ${r} V${n(y + h)}Z`;
/** Isometric cube: top face, left face, right face (top vertex at cx,ty; size a). */
const cube = (cx: number, ty: number, a: number, top: string, left: string, right: string): IconPart[] => [
  { d: `M${cx} ${ty} L${n(cx + a)} ${n(ty + a / 2)} L${cx} ${n(ty + a)} L${n(cx - a)} ${n(ty + a / 2)}Z`, fill: top },
  { d: `M${n(cx - a)} ${n(ty + a / 2)} L${cx} ${n(ty + a)} V${n(ty + 2 * a)} L${n(cx - a)} ${n(ty + 1.5 * a)}Z`, fill: left },
  { d: `M${n(cx + a)} ${n(ty + a / 2)} L${cx} ${n(ty + a)} V${n(ty + 2 * a)} L${n(cx + a)} ${n(ty + 1.5 * a)}Z`, fill: right },
];
/** Blue isometric cube (light top, mid left, deep right). */
const blueCube = (cx: number, ty: number, a: number) => cube(cx, ty, a, "#83C5FF", MID, DEEP);
/** White line work on a filled glyph. */
const line = (d: string, sw = 1.5, stroke = WHITE): IconPart => ({ d, stroke, sw });

const glyph = (key: string, label: string, accent: string, abbrev: string, parts: IconPart[]): IconDef => ({
  key,
  label,
  group: "azure",
  accent,
  abbrev,
  motif: [],
  style: "glyph",
  parts,
});

export const AZURE_ICONS: IconDef[] = [
  // ======================= compute =======================
  // monitor with a VM cube on screen + grey stand
  glyph("az-vm", "Virtual Machine", "#0078D4", "VM", [
    { d: "M9.4 16.2 L8.4 20.2 H15.6 L14.6 16.2Z", grad: GREY },
    { d: rr(6.4, 19.6, 11.2, 2, 0.8), fill: "#8A8A8A" },
    { d: rr(1.5, 2.5, 21, 14.6, 1.3), grad: BLUE },
    { d: "M12 5.1 L16.3 7.4 L12 9.7 L7.7 7.4Z", fill: WHITE },
    { d: "M7.7 7.4 L12 9.7 V14.6 L7.7 12.3Z", fill: PALE },
    { d: "M16.3 7.4 L12 9.7 V14.6 L16.3 12.3Z", fill: LIGHT },
  ]),
  // globe inside a browser window
  glyph("az-appsvc", "App Service", "#0078D4", "APP", [
    { d: rr(1.5, 2.5, 21, 19, 1.6), grad: BLUE },
    { d: rrTop(1.5, 2.5, 21, 3.8, 1.6), fill: DEEP },
    { d: circ(4.1, 4.4, 0.75), fill: WHITE },
    { d: circ(6.5, 4.4, 0.75), fill: WHITE, opacity: 0.7 },
    { d: circ(12, 14, 5.8), fill: WHITE },
    line(ell(12, 14, 2.5, 5.8), 1, "#0078D4"),
    line("M6.2 14 H17.8 M7.2 10.9 H16.8 M7.2 17.1 H16.8", 1, "#0078D4"),
  ]),
  // lightning bolt between angle brackets
  glyph("az-functions", "Functions", "#FFB900", "FN", [
    { d: "M7.2 4.6 L1.5 12 L7.2 19.4 L9.4 17.6 L5.1 12 L9.4 6.4Z", grad: BLUE },
    { d: "M16.8 4.6 L22.5 12 L16.8 19.4 L14.6 17.6 L18.9 12 L14.6 6.4Z", grad: BLUE },
    { d: "M13.9 1.5 L7.6 13.2 H11.5 L9.8 22.5 L16.6 10.2 H12.6 L15.9 1.5Z", grad: AMBER },
  ]),
  // ring of an "environment" around a container cube
  glyph("az-containerapps", "Container Apps", "#773ADC", "ACA", [
    { d: circ(12, 12, 10.5) + hole(12, 12, 7.9), grad: PURPLE },
    { d: circ(12, 1.9, 1.5), fill: LIGHT },
    ...cube(12, 6.4, 5.6, "#D7C2FB", "#9A62E8", "#5B2BB0"),
  ]),
  // cluster of three cubes
  glyph("az-aks", "AKS", "#326CE5", "AKS", [
    ...cube(12, 1.5, 5, "#D7C2FB", "#9A62E8", "#5B2BB0"),
    ...blueCube(6.5, 11.5, 5),
    ...blueCube(17.5, 11.5, 5),
  ]),
  // shelf holding container cubes
  glyph("az-acr", "Container Registry", "#0078D4", "ACR", [
    { d: "M1.5 6 H4.2 V19.3 H19.8 V6 H22.5 V20.6 a1.4 1.4 0 0 1 -1.4 1.4 H2.9 a1.4 1.4 0 0 1 -1.4 -1.4Z", grad: BLUE },
    ...blueCube(8.6, 11.2, 3.6),
    ...blueCube(15.4, 11.2, 3.6),
    ...cube(12, 5, 3.6, WHITE, PALE, LIGHT),
  ]),
  // browser window with static page blocks
  glyph("az-staticweb", "Static Web Apps", "#773ADC", "SWA", [
    { d: rr(1.5, 2.5, 21, 19, 1.6), grad: PURPLE },
    { d: rrTop(1.5, 2.5, 21, 3.8, 1.6), fill: "#552F99" },
    { d: circ(4.1, 4.4, 0.75), fill: WHITE },
    { d: circ(6.5, 4.4, 0.75), fill: WHITE, opacity: 0.7 },
    { d: rr(4, 8.6, 7.4, 6.2, 0.6), fill: LIGHT },
    { d: rr(12.8, 8.6, 7.2, 1.6, 0.6), fill: WHITE },
    { d: rr(12.8, 11.4, 5.6, 1.6, 0.6), fill: WHITE, opacity: 0.8 },
    { d: rr(12.8, 14.2, 6.4, 1.6, 0.6), fill: WHITE, opacity: 0.8 },
    { d: rr(4, 16.6, 16, 2.6, 0.6), fill: WHITE },
  ]),

  // ======================= storage & databases =======================
  // stacked storage trays
  glyph("az-storage", "Storage Account", "#0078D4", "STG", [
    { d: rr(1.5, 15.6, 21, 6, 1.1), grad: ["#1490DF", "#005BA1"] },
    { d: rr(1.5, 9, 21, 6, 1.1), grad: ["#3C91E5", "#0F6CBD"] },
    { d: rr(1.5, 2.4, 21, 6, 1.1), grad: BLUE },
    { d: rr(4.2, 4.7, 6.5, 1.4, 0.7), fill: WHITE },
    { d: rr(4.2, 11.3, 6.5, 1.4, 0.7), fill: WHITE },
    { d: rr(4.2, 17.9, 6.5, 1.4, 0.7), fill: WHITE },
    { d: circ(19, 5.4, 1), fill: LIGHT },
    { d: circ(19, 12, 1), fill: LIGHT },
    { d: circ(19, 18.6, 1), fill: LIGHT },
  ]),
  // container holding blobs
  glyph("az-blob", "Blob Storage", "#0078D4", "BLB", [
    { d: rr(1.5, 3.5, 21, 18, 1.6), grad: BLUE },
    { d: rrTop(1.5, 3.5, 21, 3.6, 1.6), fill: DEEP },
    { d: circ(8.2, 13.4, 3.3), fill: WHITE },
    { d: circ(15.9, 11.3, 2.3), fill: LIGHT },
    { d: circ(15.6, 17.1, 2), fill: PALE },
  ]),
  // cylinder with a white SQL band
  glyph("az-sql", "SQL Database", "#0078D4", "SQL", [
    { d: "M3.5 4.8 V19.2 A8.5 3 0 0 0 20.5 19.2 V4.8Z", grad: BLUE },
    { d: ell(12, 4.8, 8.5, 3), fill: "#9CD3FF" },
    { d: ell(12, 4.8, 6, 1.7), fill: MID, opacity: 0.55 },
    { d: "M3.5 9.6 A8.5 3 0 0 0 20.5 9.6 V15.6 A8.5 3 0 0 1 3.5 15.6Z", fill: WHITE },
    line("M9 13.5 C9 12.6 6.5 12.5 6.5 13.6 C6.5 14.8 9.1 14.4 9.1 15.7 C9.1 16.9 6.5 16.8 6.4 15.9", 1.05, "#0078D4"),
    line(ell(12.1, 14.7, 1.6, 2), 1.05, "#0078D4"),
    line("M12.8 15.9 L14.1 17.2", 1.05, "#0078D4"),
    line("M15.6 12.4 V16.8 H17.9", 1.05, "#0078D4"),
  ]),
  // planet with a tilted orbit
  glyph("az-cosmos", "Cosmos DB", "#326CE5", "COS", [
    line("M2.4 16.4 A10.6 3.6 -24 0 1 21.6 7.6", 1.6, DEEP),
    { d: circ(12, 12, 7.9), grad: CYAN },
    { d: circ(9.3, 9.1, 2.3), fill: WHITE, opacity: 0.35 },
    line("M2.4 16.4 A10.6 3.6 -24 0 0 21.6 7.6", 1.7, DEEP),
    { d: circ(20.3, 4.1, 1.6), fill: LIGHT },
    { d: "M4.6 2.6 L5.2 4.1 L6.7 4.7 L5.2 5.3 L4.6 6.8 L4 5.3 L2.5 4.7 L4 4.1Z", fill: "#1490DF" },
  ]),
  // stacked cache layers
  glyph("az-redis", "Cache for Redis", "#C81E1E", "RDS", [
    ...[10.3, 5.9, 1.5].flatMap((y, i): IconPart[] => [
      { d: `M2 ${n(y + 5)} L12 ${n(y + 10)} L22 ${n(y + 5)} V${n(y + 6.8)} L12 ${n(y + 11.8)} L2 ${n(y + 6.8)}Z`, fill: "#9B1414" },
      { d: `M12 ${y} L22 ${n(y + 5)} L12 ${n(y + 10)} L2 ${n(y + 5)}Z`, grad: i === 2 ? ["#FF8A8A", "#E33838"] : RED },
    ]),
    { d: "M12 4.3 L13 5.9 L14.8 6.5 L13 7.1 L12 8.7 L11 7.1 L9.2 6.5 L11 5.9Z", fill: WHITE },
  ]),

  // ======================= networking =======================
  // <···> brackets with green dots
  glyph("az-vnet", "Virtual Network", "#326CE5", "VNET", [
    { d: "M7 5.2 L1.5 12 L7 18.8 L9.2 17 L5.2 12 L9.2 7Z", grad: BLUE },
    { d: "M17 5.2 L22.5 12 L17 18.8 L14.8 17 L18.8 12 L14.8 7Z", grad: BLUE },
    { d: circ(8.6, 12, 1.5), grad: GREEN },
    { d: circ(12, 12, 1.5), grad: GREEN },
    { d: circ(15.4, 12, 1.5), grad: GREEN },
  ]),
  // one node fanning out to three
  glyph("az-lb", "Load Balancer", "#0078D4", "LB", [
    line("M12 7 L4.5 17.5 M12 7 V17.5 M12 7 L19.5 17.5", 1.7, "#5EA0EF"),
    { d: circ(12, 5.6, 4.1), grad: BLUE },
    { d: circ(12, 5.6, 1.6), fill: WHITE },
    { d: circ(4.5, 19, 3), grad: GREEN },
    { d: circ(12, 19, 3), grad: GREEN },
    { d: circ(19.5, 19, 3), grad: GREEN },
  ]),
  // gateway block routing one stream into three
  glyph("az-appgw", "Application Gateway", "#0078D4", "AGW", [
    { d: rr(1.5, 2.5, 21, 19, 2.2), grad: BLUE },
    { d: rr(1.5, 2.5, 5.2, 19, 2.2), fill: DEEP },
    line("M4.1 12 H10.5 M10.5 12 L17 7 M10.5 12 H17.4 M10.5 12 L17 17", 1.6),
    { d: "M16.1 5.3 L19.4 6.1 L17.6 8.9Z", fill: WHITE },
    { d: "M16.6 10.1 L19.8 12 L16.6 13.9Z", fill: WHITE },
    { d: "M17.6 15.1 L19.4 17.9 L16.1 18.7Z", fill: WHITE },
    { d: circ(10.5, 12, 1.5), fill: LIGHT },
  ]),
  // arched doorway with an entering arrow
  glyph("az-frontdoor", "Front Door", "#0078D4", "FD", [
    { d: "M2 22 V11.5 A10 10 0 0 1 22 11.5 V22Z", grad: BLUE },
    { d: "M2 22 V11.5 A10 10 0 0 1 7 2.84 V22Z", fill: DEEP, opacity: 0.5 },
    { d: "M7.4 22 V13.4 A4.6 4.6 0 0 1 16.6 13.4 V22Z", fill: WHITE },
    line("M9.2 17.6 H14.2 M12.4 15.6 L14.4 17.6 L12.4 19.6", 1.4, "#0078D4"),
    { d: circ(12, 5.4, 1.3), fill: LIGHT },
  ]),
  // cloud carrying </> (API surface)
  glyph("az-apim", "API Management", "#326CE5", "APIM", [
    { d: "M6.6 20.5 A5.1 5.1 0 0 1 5.6 10.4 A6.6 6.6 0 0 1 17.9 8.9 A5.8 5.8 0 0 1 17.6 20.5Z", grad: CYAN },
    line("M9.4 11.9 L6.9 14.6 L9.4 17.3 M15 11.9 L17.5 14.6 L15 17.3 M13.1 11 L11.3 18.2", 1.5),
  ]),

  // ======================= integration & messaging =======================
  // message cards travelling through a queue
  glyph("az-servicebus", "Service Bus", "#0078D4", "SB", [
    { d: rr(1.5, 4.5, 21, 15, 1.8), grad: BLUE },
    { d: rr(3.6, 8, 4.6, 8, 0.6), fill: WHITE, opacity: 0.5 },
    { d: rr(9.7, 8, 4.6, 8, 0.6), fill: WHITE, opacity: 0.78 },
    { d: rr(15.8, 8, 4.6, 8, 0.6), fill: WHITE },
    line("M4.3 9 L5.9 10.4 L7.5 9", 0.9, "#0078D4"),
    line("M10.4 9 L12 10.4 L13.6 9", 0.9, "#0078D4"),
    line("M16.5 9 L18.1 10.4 L19.7 9", 0.9, "#0078D4"),
  ]),
  // hub bar feeding three partition lanes
  glyph("az-eventhub", "Event Hub", "#0078D4", "EH", [
    { d: rr(1.5, 2, 5, 20, 1.4), fill: DEEP },
    { d: rr(7.6, 2.6, 14.9, 5, 2.5), grad: CYAN },
    { d: rr(7.6, 9.5, 14.9, 5, 2.5), grad: CYAN },
    { d: rr(7.6, 16.4, 14.9, 5, 2.5), grad: CYAN },
    { d: circ(11.6, 5.1, 1.1) + circ(15.4, 5.1, 1.1), fill: WHITE },
    { d: circ(11.6, 12, 1.1) + circ(15.4, 12, 1.1) + circ(19.2, 12, 1.1), fill: WHITE },
    { d: circ(11.6, 18.9, 1.1), fill: WHITE },
    { d: rr(3, 7, 2, 1.2, 0.6) + rr(3, 11.4, 2, 1.2, 0.6) + rr(3, 15.8, 2, 1.2, 0.6), fill: LIGHT },
  ]),
  // 3×3 event grid, hub in the centre
  glyph("az-eventgrid", "Event Grid", "#0078D4", "EG", [
    line("M5 5 L19 19 M19 5 L5 19 M5 12 H19 M12 5 V19", 1.3, "#5EA0EF"),
    { d: rr(1.5, 1.5, 6, 6, 1.2) + rr(16.5, 1.5, 6, 6, 1.2), grad: BLUE },
    { d: rr(1.5, 16.5, 6, 6, 1.2) + rr(16.5, 16.5, 6, 6, 1.2), grad: BLUE },
    { d: circ(12, 4.5, 2) + circ(4.5, 12, 2) + circ(19.5, 12, 2) + circ(12, 19.5, 2), fill: LIGHT },
    { d: rr(8, 8, 8, 8, 1.6), grad: PURPLE },
    { d: circ(12, 12, 1.7), fill: WHITE },
  ]),
  // workflow: trigger → two steps
  glyph("az-logicapps", "Logic Apps", "#0078D4", "LA", [
    line("M12 8 V11.6 M5.5 15.5 V11.6 H18.5 V15.5", 1.6, "#5EA0EF"),
    { d: rr(7.5, 1.5, 9, 6.5, 1.3), grad: BLUE },
    { d: rr(1.5, 15, 8, 7.5, 1.3), grad: CYAN },
    { d: rr(14.5, 15, 8, 7.5, 1.3), grad: CYAN },
    line("M10.2 4.75 H13.8", 1.4),
    { d: circ(5.5, 18.75, 1.5), fill: WHITE },
    { d: circ(18.5, 18.75, 1.5), fill: WHITE },
  ]),

  // ======================= analytics & AI =======================
  // factory with a pipeline arrow
  glyph("az-datafactory", "Data Factory", "#0078D4", "ADF", [
    { d: "M1.5 22 V11.2 L7.2 14.6 V11.2 L12.9 14.6 V11.2 L17.4 13.9 V3 H21.2 a1.3 1.3 0 0 1 1.3 1.3 V22Z", grad: BLUE },
    { d: rr(17.4, 3, 5.1, 2.2, 0.8), fill: DEEP },
    line("M4.2 18.4 H14.2 M12.2 16.4 L14.2 18.4 L12.2 20.4", 1.5),
    { d: rr(17.6, 15.6, 2.8, 2.8, 0.4), fill: LIGHT },
  ]),
  // analytics hexagon with rising bars
  glyph("az-synapse", "Synapse Analytics", "#0078D4", "SYN", [
    { d: "M12 1.5 L21.6 7 V17 L12 22.5 L2.4 17 V7Z", grad: CYAN },
    { d: "M12 1.5 L21.6 7 L12 12.5 L2.4 7Z", fill: WHITE, opacity: 0.22 },
    { d: rr(6.6, 13.2, 2.6, 4.4, 0.5), fill: WHITE },
    { d: rr(10.7, 10.4, 2.6, 7.2, 0.5), fill: WHITE },
    { d: rr(14.8, 7.6, 2.6, 10, 0.5), fill: LIGHT },
  ]),
  // stacked layer chevrons (lakehouse)
  glyph("az-databricks", "Databricks", "#FF3621", "DBX", [
    { d: "M12 1.6 L21.5 6.6 L12 11.6 L2.5 6.6Z", grad: ["#FF7A5C", "#FF3621"] },
    { d: "M2.5 9.6 L12 14.6 L21.5 9.6 V12.4 L12 17.4 L2.5 12.4Z", fill: "#E0301E" },
    { d: "M2.5 14.6 L12 19.6 L21.5 14.6 V17.4 L12 22.4 L2.5 17.4Z", fill: "#B8240F" },
  ]),
  // AI sparkle on a teal orb
  glyph("az-openai", "Azure OpenAI", "#0E8A92", "AOAI", [
    { d: circ(12, 12, 10.5), grad: TEAL },
    { d: "M11.4 4.6 C12 9.4 13.8 11.2 18.6 11.8 C13.8 12.4 12 14.2 11.4 19 C10.8 14.2 9 12.4 4.2 11.8 C9 11.2 10.8 9.4 11.4 4.6Z", fill: WHITE },
    { d: "M17.2 3.8 C17.4 5.5 18 6.1 19.7 6.3 C18 6.5 17.4 7.1 17.2 8.8 C17 7.1 16.4 6.5 14.7 6.3 C16.4 6.1 17 5.5 17.2 3.8Z", fill: PALE },
  ]),

  // ======================= management & security =======================
  // heartbeat pulse on a dial
  glyph("az-monitor", "Monitor", "#326CE5", "MON", [
    { d: circ(12, 12, 10.5), grad: BLUE },
    { d: circ(12, 12, 8) + hole(12, 12, 6.8), fill: WHITE, opacity: 0.25 },
    line("M4.2 12.6 H8.4 L10.3 7.6 L13.4 17 L15.4 12.6 H19.8", 1.7),
  ]),
  // insight lightbulb
  glyph("az-appinsights", "Application Insights", "#773ADC", "AI", [
    { d: "M7.3 14.9 A7.6 7.6 0 1 1 16.7 14.9 C15.9 15.7 15.5 16.6 15.5 17.6 H8.5 C8.5 16.6 8.1 15.7 7.3 14.9Z", grad: PURPLE },
    { d: circ(9.4, 6.6, 2), fill: WHITE, opacity: 0.4 },
    line("M9.8 12.4 L12 10.2 L14.2 12.4 M12 10.2 V17.4", 1.2),
    { d: rr(8.3, 18.2, 7.4, 1.8, 0.9), grad: GREY },
    { d: rr(9.4, 20.5, 5.2, 1.8, 0.9), fill: "#6B6B6B" },
  ]),
  // vault dial with a keyhole
  glyph("az-keyvault", "Key Vault", "#0078D4", "KV", [
    { d: circ(12, 12, 10.5), grad: BLUE },
    { d: circ(12, 12, 6.9), fill: WHITE },
    { d: circ(12, 10.4, 2.1), fill: "#0078D4" },
    { d: "M10.9 11.6 L10.1 16.3 H13.9 L13.1 11.6Z", fill: "#0078D4" },
    {
      d: [0, 45, 90, 135, 180, 225, 270, 315]
        .map((a) => circ(12 + 8.7 * Math.cos((a * Math.PI) / 180), 12 + 8.7 * Math.sin((a * Math.PI) / 180), 0.75))
        .join(""),
      fill: LIGHT,
    },
  ]),
  // faceted identity pyramid
  glyph("az-entra", "Entra ID", "#0078D4", "ID", [
    { d: "M12 1.5 L1.5 16.8 L12 22.5Z", grad: ["#7FD3FF", "#1490DF"] },
    { d: "M12 1.5 L22.5 16.8 L12 22.5Z", grad: ["#2E8FE6", "#005BA1"] },
    { d: "M12 8.6 L6.6 16.4 L12 19.4 L17.4 16.4Z", fill: WHITE, opacity: 0.9 },
    { d: "M12 8.6 L17.4 16.4 L12 19.4Z", fill: PALE },
  ]),
];
