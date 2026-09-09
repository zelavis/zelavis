import * as React from "react";

import {
  defineServiceFrameElement,
  serviceFrameElementName,
} from "#/components/service-frame-element";

export function ServiceFrame({
  src,
  title,
  sandboxed = true,
  grant,
}: {
  src: string;
  title: string;
  /**
   * Defaults to sandboxed. A caller that cannot establish a page is trusted
   * must not accidentally grant it the operator's session, so the safe value is
   * the one you get by omission.
   */
  sandboxed?: boolean;
  /** API namespace a sandboxed page may reach through the broker. */
  grant?: { serviceName: string; apiPath: string };
}) {
  React.useEffect(() => {
    defineServiceFrameElement();
  }, []);

  return React.createElement(serviceFrameElementName, {
    src,
    title,
    sandboxed: String(sandboxed),
    grant: grant ? JSON.stringify(grant) : undefined,
  });
}
