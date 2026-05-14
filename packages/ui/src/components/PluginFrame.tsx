import * as React from "react";

import {
  definePluginFrameElement,
  pluginFrameElementName,
} from "#/components/plugin-frame-element";

export function PluginFrame({
  src,
  title,
}: {
  src: string;
  title: string;
}) {
  React.useEffect(() => {
    definePluginFrameElement();
  }, []);

  return React.createElement(pluginFrameElementName, {
    src,
    title,
  });
}
