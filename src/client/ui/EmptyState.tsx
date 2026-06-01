import type { ReactNode } from "react";

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="grid min-h-[220px] place-items-center rounded-lg border border-dashed border-default-300 text-default-500">{children}</div>;
}
