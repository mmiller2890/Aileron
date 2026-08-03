import {
  Theme,
  AlwaysOnTopToggle,
  AppIconToggle,
  AutostartToggle,
  DeleteChats,
} from "./components";
import { useSettings } from "@/hooks";
import { PageLayout } from "@/layouts";

const Settings = () => {
  const settings = useSettings();

  return (
    <PageLayout title="Settings" description="Manage your settings">
      {/* Theme */}
      <Theme />

      {/* Autostart Toggle */}
      <AutostartToggle />

      {/* App Icon Toggle */}
      <AppIconToggle />

      {/* Always On Top Toggle */}
      <AlwaysOnTopToggle />

      {/* Danger Zone */}
      <DeleteChats {...settings} />
    </PageLayout>
  );
};

export default Settings;
