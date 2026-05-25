import * as React from "react";

import {
  defineServiceFrameElement,
  serviceFrameElementName,
} from "#/components/service-frame-element";

export function ServiceFrame({
  src,
  title,
}: {
  src: string;
  title: string;
}) {
  React.useEffect(() => {
    defineServiceFrameElement();
  }, []);

  return React.createElement(serviceFrameElementName, {
    src,
    title,
  });
}
