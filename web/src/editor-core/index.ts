/**
 * editor-core — public API of the framework-agnostic SVG editing engine.
 *
 * Depends on NOTHING internal except shared/utils/esc (the security helper the
 * ADR co-locates with serialize). No React, no Zustand, no feature imports.
 * Everything a feature/store needs from the engine is re-exported here.
 */
export * from "./types";
export * from "./camera";
export * from "./selection";
export * from "./transform";
export { History } from "./history";
export {
  parseSvg,
  loadInto,
  reindex,
  currentSvgString,
  esc,
  type ParsedSvg,
} from "./serialize";
