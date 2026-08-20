import { Loader2 } from "lucide-react";
import {
  formatSttProgressPhase,
  type SttModelProgress,
} from "@/hooks/useSttStatus";

export const SttInitOverlay = ({
  progress,
}: {
  progress: SttModelProgress | null;
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
    <div className="flex flex-col items-center gap-3 p-6 rounded-lg border border-border bg-card shadow-lg">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
      <div className="text-center">
        <p className="text-sm font-medium">Preparing local speech models</p>
        <p className="text-xs text-muted-foreground mt-1">
          {progress
            ? `${formatSttProgressPhase(progress)} · ${Math.round(progress.fractionCompleted * 100)}%`
            : "First use may download hundreds of MB and take several minutes"}
        </p>
        {progress && (
          <div className="mt-3 h-1.5 w-64 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${progress.fractionCompleted * 100}%` }}
            />
          </div>
        )}
      </div>
    </div>
  </div>
);
