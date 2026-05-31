import clsx from "clsx";
import type { ReactNode } from "react";

export type BadgeColor = "default" | "warning" | "danger" | "success" | "secondary";

// Small inline pill — replaces daisyUI's `badge badge-xs badge-*` with HeroUI
// semantic colours that read on Finius's light surfaces.
const BADGE: Record<BadgeColor, string> = {
  default: "bg-default-200 text-default-700",
  warning: "bg-warning/20 text-warning-700",
  danger: "bg-danger/20 text-danger-700",
  success: "bg-success/20 text-success-700",
  secondary: "bg-secondary/20 text-secondary-700",
};

export function Badge({
  color = "default",
  pulse,
  children,
}: {
  color?: BadgeColor;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium shrink-0",
        BADGE[color],
        pulse && "animate-pulse",
      )}
    >
      {children}
    </span>
  );
}
