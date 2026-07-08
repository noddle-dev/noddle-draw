/**
 * shared/ui/IconButton — toolbar-style borderless button (icon/label glyphs).
 * Supports an `active` state used by the tool buttons.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  children: ReactNode;
}

export function IconButton({
  active = false,
  className = "",
  children,
  ...rest
}: IconButtonProps) {
  const cls = [active ? "active" : "", className].filter(Boolean).join(" ");
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
