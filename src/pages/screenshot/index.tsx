import { ScreenshotConfigs } from "./components";
import { useSettings } from "@/hooks";
import { PageLayout } from "@/layouts";

const Settings = () => {
  const settings = useSettings();
  return (
    <PageLayout
      title="Screenshot"
      description="How screenshots are captured and what is asked about them"
    >
      {/* Screenshot Configs */}
      <ScreenshotConfigs {...settings} />
    </PageLayout>
  );
};

export default Settings;
