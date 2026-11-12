import { Sparkles } from "lucide-react"
import type { ComponentProps, PointerEvent } from "react"
import { Link } from "react-router"

import { Button, buttonVariants } from "#/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#/components/ui/tooltip"
import { cn } from "#/lib/utils"

type AssistantButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "nativeButton" | "onPointerEnter" | "onPointerLeave" | "render"
> & {
  label: string
  surface?: "default" | "sidebar"
  to?: string
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"]
}

function setGlowDirection(element: HTMLElement, reverse: boolean) {
  for (const animation of element.getAnimations()) {
    if (
      animation instanceof CSSAnimation &&
      animation.animationName === "assistant-glow-steam"
    ) {
      animation.updatePlaybackRate(reverse ? -1 : 1)
    }
  }
}

export function AssistantButton({
  className,
  label,
  surface = "default",
  to,
  tooltipSide = "top",
  variant = "outline",
  size = "icon",
  ...props
}: AssistantButtonProps) {
  const assistantClassName = cn(
    "assistant-glow",
    surface === "sidebar" && "assistant-glow-sidebar",
    className,
  )
  const content = (
    <>
      <Sparkles className="size-4" />
      <span className="sr-only">{label}</span>
    </>
  )
  const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
    setGlowDirection(event.currentTarget, true)
  }
  const handlePointerLeave = (event: PointerEvent<HTMLElement>) => {
    setGlowDirection(event.currentTarget, false)
  }

  return (
    <Tooltip>
      {to ? (
        <TooltipTrigger
          render={
            <Link
              to={to}
              viewTransition
              className={cn(
                buttonVariants({ variant, size }),
                assistantClassName,
              )}
              onPointerEnter={handlePointerEnter}
              onPointerLeave={handlePointerLeave}
            />
          }
        >
          {content}
        </TooltipTrigger>
      ) : (
        <TooltipTrigger
          render={
            <Button
              variant={variant}
              size={size}
              className={assistantClassName}
              onPointerEnter={handlePointerEnter}
              onPointerLeave={handlePointerLeave}
              {...props}
            />
          }
        >
          {content}
        </TooltipTrigger>
      )}
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  )
}
