import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * Convenience wrapper: most call sites want "this element, with this text on hover".
 * `content` of `null` renders the child untouched so callers can make tooltips conditional.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  ...props
}: {
  content: ReactNode;
  children: ReactNode;
  side?: ComponentProps<typeof TooltipPrimitive.Content>["side"];
} & Omit<ComponentProps<typeof TooltipPrimitive.Root>, "children">) {
  if (content === null || content === undefined || content === "") return <>{children}</>;
  return (
    <TooltipPrimitive.Root {...props}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            "bg-popover text-popover-foreground border-border z-50 max-w-xs rounded-md border px-2 py-1 text-xs shadow-md",
            "animate-in fade-in-0 zoom-in-95",
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
