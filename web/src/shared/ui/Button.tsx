/** shared/ui/Button — themed button primitive (maps to .btn tokens). */
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** "primary" renders the accent-filled variant. */
  variant?: "default" | "primary";
  children: ReactNode;
}

export function Button({
  variant = "default",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const cls = ["btn", variant === "primary" ? "primary" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
