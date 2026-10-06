import { Button, Card, DragButton, AileronMark } from "@/components";
import { RefreshCcwIcon } from "lucide-react";

export const ErrorLayout = ({ isCompact }: { isCompact?: boolean }) => {
  return isCompact ? (
    <Card className="flex flex-row w-screen h-screen items-center justify-between p-4">
      <AileronMark size={28} />
      <p className="text-sm md:text-base">
        Something went wrong. Reload to restart the app.
      </p>

      <div className="flex flex-row items-center gap-2">
        <Button
          size="icon"
          onClick={() => window.location.reload()}
          title="Reload"
          aria-label="Reload"
        >
          <RefreshCcwIcon className="size-4" />
        </Button>
        <DragButton />
      </div>
    </Card>
  ) : (
    <div className="relative flex h-screen w-screen flex-col items-center justify-center overflow-hidden bg-background">
      <div className="flex max-w-[480px] flex-col items-center gap-6 px-6 text-center select-none">
        <AileronMark size={56} />
        <div className="space-y-2">
          <h1
            className="text-xl uppercase tracking-[0.24em] text-primary"
            style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
          >
            Something went wrong
          </h1>
          <p className="text-sm text-muted-foreground">
            This screen hit an unexpected error. Your saved conversations and
            settings are not affected. Reload to carry on.
          </p>
        </div>
        <Button
          variant="default"
          onClick={() => window.location.reload()}
          className="w-[200px]"
        >
          <RefreshCcwIcon className="size-4" /> Reload
        </Button>
      </div>
    </div>
  );
};
