/**
 * features/canvas/panState — shared "Space is held" flag.
 *
 * Holding Space turns the whole canvas into a hand-pan (Figma/Lucid): the
 * Canvas key handlers write this flag, and every pointer-down owner that
 * would otherwise claim the gesture (node drag, resize grips, connect
 * ports) reads it and steps aside so the native canvas pan wins. A plain
 * module object (not store state) — nothing re-renders on it; the hand
 * cursor is a CSS class toggled directly on the host.
 */
export const panState = { spaceHeld: false };
