import { useEffect } from "react";
import { useSettings, type PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import { setEnabled, start } from "./focus";
import { startInlineVis } from "./inline-vis";
import "./app.css";

// app.css hides BB's external editor picker, gives the icons in its bars one
// tone, and fixes a layout in Safari; focus.ts keeps a Tesla's keyboard from
// coming up each time a thread or a tab opens; inline-vis.ts shows inline
// visualizations in BB's iOS app.

/** Marks the page while the UI Polish setting is off; app.css reads the mark. */
function UiPolishSwitch() {
  const off = useSettings().values?.uiPolish === false;
  useEffect(() => {
    setEnabled(!off);
    document.documentElement.toggleAttribute("data-superhuman-ui-polish-off", off);
    return () => {
      setEnabled(true);
      document.documentElement.removeAttribute("data-superhuman-ui-polish-off");
    };
  }, [off]);
  return null;
}

export default function registerUiPolish(app: PluginAppBuilder) {
  app.contentScripts.register({ id: "ui-polish", mount: start });
  app.contentScripts.register({
    id: "ui-polish-inline-vis",
    mount: startInlineVis,
  });
  app.slots.experimental_appOverlay({
    id: "ui-polish-switch",
    component: UiPolishSwitch,
  });
}
