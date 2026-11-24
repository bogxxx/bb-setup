import { useEffect } from "react";
import { useSettings, type PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import { startCardDismiss } from "./dismiss";
import "./app.css";

// The setting reaches the page through this React bridge.
function DismissCards() {
  const enabled = useSettings().values?.dismissCards !== false;
  useEffect(() => (enabled ? startCardDismiss(document) : undefined), [enabled]);
  return null;
}

export default function registerDismissCards(app: PluginAppBuilder) {
  app.slots.experimental_appOverlay({
    id: "dismiss-cards",
    component: DismissCards,
  });
}
