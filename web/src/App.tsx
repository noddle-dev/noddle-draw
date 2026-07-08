/**
 * App — top-level router shell.
 *
 * Three product screens (dashboard → generate → editor) selected by
 * appStore.view, synced with the URL: a board's shareable address is
 * /d/{docId} (deep links + back/forward work; the backend serves the SPA
 * shell for /d/*). Whole-window SVG drag-and-drop uploads a file and jumps
 * to the editor.
 */
import { useEffect } from "react";
import { LoginScreen } from "./features/account/LoginScreen";
import { SettingsScreen } from "./features/account/SettingsScreen";
import { UpgradeModal } from "./features/account/UpgradeModal";
import { DashboardScreen } from "./features/dashboard";
import { GenerateScreen } from "./features/generate";
import { EditorScreen } from "./features/editor";
import { GameRoom, TriviaRoom, WordBombRoom } from "./features/games";
import { JobsTray } from "./features/jobs/JobsTray";
import { applyLocation, useAppStore } from "./state/appStore";
import { useAuthStore } from "./state/authStore";
import { useEditorStore } from "./state/editorStore";
import { screenToContent } from "./editor-core";
import { addImageToBoard, imageFromDataTransfer } from "./features/editor/pasteImage";

export default function App() {
  const view = useAppStore((s) => s.view);
  const me = useAuthStore((s) => s.me);
  const authRetryDocId = useAppStore((s) => s.authRetryDocId);
  // Dashboard + generate need an identity (Lucid-style login page for guests);
  // editor stays guest-reachable for link-shared boards, games via room links.
  const anon = useAuthStore((s) => s.anon);
  // Anonymous mode (NODDLE_ANON): guests draw without an account — no gate.
  const needsLogin = !anon && me !== null && me.kind !== "user";

  // URL routing: parse the location on boot and on back/forward.
  useEffect(() => {
    applyLocation();
    void useAuthStore.getState().loadMe(); // who am I? (cookie session)
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
  }, []);

  // A guest hit a private board → after sign-in, reopen it automatically.
  useEffect(() => {
    if (me?.kind === "user" && authRetryDocId) {
      const id = authRetryDocId;
      useAppStore.getState().clearAuthPrompt();
      useAppStore.getState().openInEditor(id);
    }
  }, [me, authRetryDocId]);

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
      {view === "dashboard" && (needsLogin ? <LoginScreen /> : <DashboardScreen />)}
      {view === "generate" && (needsLogin ? <LoginScreen /> : <GenerateScreen />)}
      {view === "settings" && (needsLogin ? <LoginScreen /> : <SettingsScreen />)}
      {view === "editor" && <EditorScreen />}
      {view === "game" && <GameRoomRoute />}
      {/* background AI jobs (image→board) — visible on every screen */}
      <JobsTray />
      {/* plan-limit upsell card — opened from anywhere via appStore.showUpgrade */}
      <UpgradeModal />
    </>
  );
}

/** Reads the active room id + game type and mounts the matching room. */
function GameRoomRoute() {
  const roomId = useAppStore((s) => s.gameRoomId);
  const gameType = useAppStore((s) => s.gameType);
  if (!roomId) return null;
  if (gameType === "trivia") return <TriviaRoom roomId={roomId} />;
  if (gameType === "wordbomb") return <WordBombRoom roomId={roomId} />;
  return <GameRoom roomId={roomId} />;
}
