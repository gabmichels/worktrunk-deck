import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "border-input bg-background placeholder:text-muted-foreground h-8 w-full rounded-md border px-2.5 text-sm transition-colors disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
