import { useEffect } from "react";
import { useSettings, type PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import "./app.css";

const MARK = "data-superhuman-no-title-bar";

/** Marks the page while the Hide Title Bar setting is on; app.css reads the mark. */
function TitleBarSwitch() {
  const on = useSettings().values?.hideTitleBar === true;
  useEffect(() => {
    document.documentElement.toggleAttribute(MARK, on);
    return () => document.documentElement.removeAttribute(MARK);
  }, [on]);
  return null;
}

export default function registerTitleBar(app: PluginAppBuilder) {
  app.slots.experimental_appOverlay({
    id: "title-bar-switch",
    component: TitleBarSwitch,
  });
}
