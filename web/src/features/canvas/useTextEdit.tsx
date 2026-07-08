/**
 * features/canvas/useTextEdit — double-click a <text> element to edit its
 * content via a floating <input> overlaid at the element's screen position.
 * Ported from editText() in `frontend/editor.js`.
 *
 * Exposes `editingRef` so the Canvas keyboard handler can ignore shortcuts
 * while the user is typing in the inline editor.
 */
import { useCallback, useRef, type RefObject } from "react";
import { useEditorStore } from "../../state/editorStore";

export function useTextEdit(
  hostRef: RefObject<HTMLElement>,
  _contentRef: RefObject<SVGGElement>,
) {
  const editingRef = useRef(false);

  const beginTextEdit = useCallback(
    (textEl: SVGTextElement) => {
      const host = hostRef.current;
      if (!host) return;
      const s = useEditorStore.getState();

      editingRef.current = true;
      const rect = textEl.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const cs = getComputedStyle(textEl);
      const fsScreen = (parseFloat(cs.fontSize) || 14) * s.cam.z;
      const orig = textEl.textContent ?? "";

      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = orig;
      inp.className = "text-edit";
      inp.style.left = rect.left - hostRect.left + "px";
      inp.style.top = rect.top - hostRect.top + "px";
      inp.style.height = Math.max(rect.height, fsScreen * 1.3) + "px";
      inp.style.width = Math.max(rect.width + 24, 60) + "px";
      inp.style.fontSize = fsScreen + "px";
      inp.style.fontFamily = cs.fontFamily;
      inp.style.fontWeight = cs.fontWeight;
      inp.style.color = textEl.getAttribute("fill") || cs.fill || "#000";
      host.appendChild(inp);

      const prevVis = textEl.style.visibility;
      textEl.style.visibility = "hidden";
      inp.focus();
      inp.select();
      s.setStatus("Editing text · Enter to save · Esc to cancel.");

      let done = false;
      const finish = (commit: boolean) => {
        if (done) return;
        done = true;
        editingRef.current = false;
        textEl.style.visibility = prevVis;
        if (commit && inp.value !== orig) {
          const st = useEditorStore.getState();
          st.beginAction();
          textEl.textContent = inp.value; // keeps x/y/class; collapses tspans
          st.commitAction();
          st.setStatus("Text updated.", "ok");
        }
        inp.remove();
      };
      inp.addEventListener("blur", () => finish(true));
      inp.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") {
          ev.preventDefault();
          finish(true);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          finish(false);
        }
      });
    },
    [hostRef],
  );

  return { beginTextEdit, editingRef };
}
