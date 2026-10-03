/**
 * features/editor/boardExports — open-format text exports (#15): the whole
 * board as noddle diagram JSON and the active page as Mermaid. Raster/vector
 * exports (SVG/PNG/GIF/Deck) live in toolbar/useExport.
 */
import { useDiagramStore } from "../../state/diagramStore";
import { boardDiagram } from "../../state/pagesStore";
import { diagramToMermaid } from "../../editor-core/diagram";

/** Download a text file (open-format exports — #15). */
function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** The whole board (all pages) as noddle's open diagram JSON — re-importable
 * via ☰ → Import file…. */
export function exportBoardJson(title: string): void {
  const payload = boardDiagram();
  downloadText(
    `${title || "board"}.json`,
    JSON.stringify(payload, null, 2),
    "application/json",
  );
}

/** The ACTIVE page as a Mermaid flowchart (structure only — layout is lossy). */
export function exportMermaid(title: string): void {
  const s = useDiagramStore.getState();
  downloadText(
    `${title || "board"}.mmd`,
    diagramToMermaid(Object.values(s.nodes), Object.values(s.edges)),
    "text/plain",
  );
}
