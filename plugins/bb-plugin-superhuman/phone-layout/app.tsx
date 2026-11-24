import { useEffect } from "react";
import { useSettings, type PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import { startDrawerHaptics } from "../haptics/drawers";
import { lockZoom } from "../zoom-lock/lock";
import { startKeyboardSwipe } from "./keyboard";
import { startPhoneLayout } from "./layout";
import { NewThreadButton } from "./new-thread";
import { startPanelSlide } from "./slide";
import { startPanelSwipe } from "./swipe";
import "./app.css";
import "./slide.css";

// The setting reaches the page through this React bridge.
function PhoneLayout() {
  const { values } = useSettings();
  const enabled = values?.phoneLayout !== false;
  useEffect(() => {
    if (!enabled) return;
    const stops = [
      startPhoneLayout(document),
      startDrawerHaptics(document),
      lockZoom(document),
      startPanelSlide(document),
      startPanelSwipe(document),
      startKeyboardSwipe(document),
    ];
    return () => stops.forEach((stop) => stop());
  }, [enabled]);
  return null;
}

export default function registerPhoneLayout(app: PluginAppBuilder) {
  app.slots.experimental_appOverlay({ id: "phone-layout", component: PhoneLayout });
  // Registered after Snooze's moon, so the bar, which runs from its end,
  // shows New thread first.
  app.slots.experimental_threadHeaderAction({
    id: "new-thread",
    title: "New thread",
    component: NewThreadButton,
  });
}
