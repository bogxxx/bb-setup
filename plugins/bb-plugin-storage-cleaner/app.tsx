// Storage Cleaner lives on its settings page, and the same view is a page
// that Customize rail can put in the sidebar.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Explorer } from "./explorer";
import {
  Categories,
  FreeSpace,
  FullDiskAccess,
  MachinePicker,
  Unreachable,
} from "./overview";
import { StorageProvider, useStorage } from "./ui";

/**
 * The machine picker, free space, the Full Disk Access request, and
 * categories, then the explorer.
 */
function StorageSection() {
  return (
    <StorageProvider>
      <Storage />
    </StorageProvider>
  );
}

function Storage() {
  const { hostId } = useStorage();
  return (
    <div className="space-y-10">
      <div className="space-y-5">
        <MachinePicker />
        <Unreachable />
        <FreeSpace />
        <FullDiskAccess />
        <Categories />
      </div>
      {/* Another machine's explorer starts at its own top. */}
      <Explorer key={hostId} />
    </div>
  );
}

function StoragePage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-4 pb-10 pt-4 md:pt-5">
        <StorageSection />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "storage",
    title: "Storage",
    component: StorageSection,
  });
  app.slots.navPanel({
    id: "storage",
    title: "Storage",
    icon: "Clean",
    path: "storage",
    component: StoragePage,
  });
});
