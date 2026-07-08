/**
 * features/account/AuthIllustration — the login modal's spot illustration.
 * Ported from landing/src/assets/illustrations/sketch-to-board.svg (the
 * illustration-craft set): a messy whiteboard photo becoming a clean noddle
 * board. Ember palette + ink strokes per BRAND.md §7; the violet ✦ marks the
 * AI transform (its one legitimate meaning).
 */
export function AuthIllustration() {
  return (
    <svg viewBox="0 0 600 400" role="img" aria-label="A messy sketch turning into a clean noddle board">
      {/* backdrop */}
      <polygon points="70,350 320,45 570,350" fill="#fdeedd" />
      {/* messy photo (left) */}
      <g transform="rotate(-7 150 190)">
        <rect x="55" y="115" width="190" height="150" rx="8" fill="#ffffff" stroke="#211e19" strokeWidth="2.5" />
        <rect x="125" y="103" width="50" height="18" rx="4" fill="#fdba74" transform="rotate(-3 150 112)" />
        <path d="M85 155 q28 -8 52 2 q3 20 -4 30 q-26 6 -49 -2 q-4 -18 1 -30 Z" fill="none" stroke="#9aa1ad" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M165 190 q22 -6 44 1 q4 16 -2 26 q-22 5 -42 -1 q-4 -14 0 -26 Z" fill="none" stroke="#9aa1ad" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M112 190 q10 22 48 18" fill="none" stroke="#9aa1ad" strokeWidth="2" strokeLinecap="round" strokeDasharray="5 5" />
        <path d="M95 235 q40 8 120 -2" fill="none" stroke="#9aa1ad" strokeWidth="2" strokeLinecap="round" />
      </g>
      {/* transformation arrow + AI spark */}
      <path d="M262 185 C 292 150, 312 148, 338 168" fill="none" stroke="#211e19" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="6 6" />
      <path d="M331 158 L 340 169 L 327 172" fill="none" stroke="#211e19" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M300 122 L302.3 129 L309 131.3 L302.3 133.6 L300 141 L297.7 133.6 L291 131.3 L297.7 129 Z" fill="#7c3aed" />
      {/* clean board (right) */}
      <g>
        <rect x="345" y="105" width="210" height="185" rx="14" fill="#ffffff" stroke="#211e19" strokeWidth="2.5" />
        <circle cx="367" cy="125" r="3" fill="#ea580c" />
        <circle cx="380" cy="125" r="3" fill="#fdba74" />
        <circle cx="393" cy="125" r="3" fill="none" stroke="#211e19" strokeWidth="2" />
        <rect x="370" y="150" width="72" height="42" rx="8" fill="#ea580c" stroke="#211e19" strokeWidth="2.5" />
        <rect x="463" y="160" width="70" height="44" rx="8" fill="#ffedd5" stroke="#211e19" strokeWidth="2.5" />
        <circle cx="420" cy="248" r="22" fill="#ffffff" stroke="#211e19" strokeWidth="2.5" />
        <path d="M442 182 L463 182" fill="none" stroke="#211e19" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M456 177 L463 182 L456 187" fill="none" stroke="#211e19" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M406 192 L406 220 L420 220" fill="none" stroke="#211e19" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M415 213 L422 220 L415 227" fill="none" stroke="#211e19" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {/* confetti */}
      <rect x="88" y="60" width="12" height="12" fill="#ea580c" transform="rotate(18 94 66)" />
      <circle cx="530" cy="70" r="7" fill="#fdba74" />
      <path d="M470 40 L484 62 L456 62 Z" fill="none" stroke="#211e19" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="60" cy="320" r="10" fill="none" stroke="#211e19" strokeWidth="2" strokeDasharray="5 5" />
      <path d="M520 320 q-30 26 -78 16" fill="none" stroke="#211e19" strokeWidth="2" strokeLinecap="round" strokeDasharray="6 6" />
    </svg>
  );
}
