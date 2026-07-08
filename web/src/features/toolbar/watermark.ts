/**
 * features/toolbar/watermark — shared free-tier export-watermark flag.
 *
 * The Noddle mark is baked into exported SVG/PNG/GIF for free-tier users only
 * (see editorStore.currentBoardSvg({watermark})). The tier is fetched once and
 * cached here so every export path (useExport + the GIF exporter) agrees.
 * Default false: never watermark a paid user before the tier is known.
 */
import { api } from "../../shared/api/client";

let _watermark = false;
let _fetched = false;

/** Fetch the caller's tier and cache whether exports should be watermarked. */
export function refreshWatermarkTier(): void {
  void api
    .mySubscription()
    .then((s) => { _watermark = s.tier === "free"; _fetched = true; })
    .catch(() => {});
}

/** Whether the current user's exports carry the watermark. */
export function watermarkOn(): boolean {
  // Kick a lazy fetch if an export happens before the editor's mount effect ran.
  if (!_fetched) refreshWatermarkTier();
  return _watermark;
}
