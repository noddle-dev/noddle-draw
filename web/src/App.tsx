/**
 * App — top-level router shell.
 *
 * Two product screens (editor ↔ generate) selected by appStore.view, synced
 * with the URL: a board's shareable address is /d/{docId} (deep links +
 * back/forward work; the backend serves the SPA shell for /d/*). Visiting `/`
 * reopens the browser's most recent board or auto-creates one — no login, no
 * dashboard (Excalidraw-style). Whole-window SVG drag-and-drop uploads a file
 * and jumps to the editor.
 */
import { useEffect } from "react";
import { GenerateScreen } from "./features/generate";
import { EditorScreen } from "./features/editor";
import { JobsTray } from "./features/jobs/JobsTray";
import { applyLocation, useAppStore } from "./state/appStore";
import { useEditorStore } from "./state/editorStore";
import { screenToContent } from "./editor-core";
import { addImageToBoard, imageFromDataTransfer } from "./features/editor/pasteImage";

export default function App() {
  const view = useAppStore((s) => s.view);

  // URL routing: parse the location on boot and on back/forward.
  useEffect(() => {
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, []);

  // Whole-window drag & drop of an SVG file → upload + open in the editor.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.add("dragover");
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.remove("dragover");
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.remove("dragover");
      // A raster image dropped while editing lands ON the board at the drop
      // point (editable <image>); SVG files still upload as a new document.
      const img = imageFromDataTransfer(e.dataTransfer);
      const refs = useEditorStore.getState().refs;
      if (img && useAppStore.getState().view === "editor" && refs) {
        const at = screenToContent(refs.content, e.clientX, e.clientY);
        void addImageToBoard(img, at);
        return;
      }
      const f = e.dataTransfer?.files?.[0];
      if (f) {
        useAppStore.getState().go("editor");
        void useEditorStore.getState().uploadFile(f);
      }
    };
    document.body.addEventListener("dragover", onDragOver);
    document.body.addEventListener("dragleave", onDragLeave);
    document.body.addEventListener("drop", onDrop);
    return () => {
      document.body.removeEventListener("dragover", onDragOver);
      document.body.removeEventListener("dragleave", onDragLeave);
      document.body.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <>
      {view === "generate" && <GenerateScreen />}
      {view === "editor" && <EditorScreen />}
      {/* background AI jobs (image→board) — visible on every screen */}
      <JobsTray />
    </>
  );
}
