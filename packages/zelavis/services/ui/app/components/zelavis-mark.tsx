import * as React from "react";
import type { LucideProps } from "lucide-react";

export const ZelavisMark = React.forwardRef<SVGSVGElement, LucideProps>(
  ({ color = "currentColor", strokeWidth: _strokeWidth, ...props }, ref) => (
    <svg
      ref={ref}
      viewBox="0 0 24 24"
      focusable="false"
      {...props}
    >
      <path
        fill={color}
        d="M6.64 4h11.7c.9 0 1.36 1.08.74 1.73L8.88 16.4h8.48c.9 0 1.36 1.08.74 1.73l-1.33 1.39a1.64 1.64 0 0 1-1.19.5H3.86c-.9 0-1.36-1.08-.74-1.73L13.32 7.6H4.86c-.9 0-1.36-1.08-.74-1.73l1.33-1.39c.31-.31.73-.49 1.19-.49Z"
      />
      <path
        fill={color}
        fillOpacity=".38"
        d="M13.32 7.6h5.02c.9 0 1.36-1.08.74-1.73l-1.33-1.39A1.64 1.64 0 0 0 16.56 4h-4.82L8.88 7.6h4.44Zm-2.64 8.8H5.66c-.9 0-1.36 1.08-.74 1.73l1.33 1.39c.31.31.73.49 1.19.49h4.82l2.86-3.6h-4.44Z"
      />
    </svg>
  ),
);

ZelavisMark.displayName = "ZelavisMark";
