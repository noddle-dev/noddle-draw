/**
 * shared/api/importBoard — one entry point for every importable format,
 * branching on extension (used by the editor's ☰ → Import file…):
 *   .svg → sanitize-upload · .drawio/.xml → server-side mxGraph parse ·
 *   .mmd → the Mermaid AI path · .json → noddle's own open format.
 * Returns the NEW board's meta; the caller decides where to open it.
 */
import { api, type DocMeta } from "./client";

export const IMPORT_ACCEPT = ".json,.drawio,.xml,.mmd,.mermaid,.svg";

export async function importBoardFile(file: File): Promise<DocMeta> {
  const name = file.name.replace(/\.[^.]+$/, "") || "Imported board";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "svg") return api.upload(file);
  if (ext === "mmd" || ext === "mermaid") {
    const out = await api.textToDiagram(await file.text(), "mermaid");
    return api.create({ name, diagram: { nodes: out.nodes, edges: out.edges } });
  }
  if (ext === "json") {
    const payload = JSON.parse(await file.text()) as {
      pages?: unknown[];
      nodes?: unknown[];
      edges?: unknown[];
    };
    const diagram = Array.isArray(payload.pages)
      ? { pages: payload.pages }
      : { nodes: (payload.nodes ?? []) as never, edges: (payload.edges ?? []) as never };
    return api.create({ name, diagram });
  }
  return api.importFile(file); // .drawio / .xml
}
