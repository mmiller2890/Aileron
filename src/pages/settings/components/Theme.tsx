import { useApp, useTheme } from "@/contexts";
import { Header, Slider } from "@/components";

export const Theme = () => {
  const { transparency, onSetTransparency } = useTheme();
  const { hasActiveLicense } = useApp();

  return (
    <div id="theme" className="relative space-y-3">
      <Header
        title="Appearance"
        description={
          hasActiveLicense
            ? "Adjust the transparency level of the application window"
            : "Adjusting window transparency needs an active license"
        }
        isMainTitle
      />

      {/* Transparency Slider */}
      <div
        className={`space-y-2 ${
          hasActiveLicense ? "" : "opacity-60 pointer-events-none"
        }`}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-4 mt-4">
            <Slider
              value={[transparency]}
              onValueChange={(value: number[]) => onSetTransparency(value[0])}
              min={0}
              max={100}
              step={1}
              className="flex-1"
            />
          </div>

          <p className="text-xs text-muted-foreground/70">
            Higher transparency lets you see through the window. Changes apply
            immediately.
          </p>
        </div>
      </div>
    </div>
  );
};
