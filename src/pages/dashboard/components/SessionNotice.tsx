import { ShieldAlertIcon, TriangleAlertIcon, LoaderIcon } from "lucide-react";
import { BarNotice } from "@/lib/live-session";

/**
 * Permission, error, and model-loading notices, shared by the control bar and
 * the dashboard home so both say the same thing the same way.
 */
export const SessionNotice = ({
  notice,
  onGrantPermission,
}: {
  notice: NonNullable<BarNotice>;
  onGrantPermission: () => void;
}) =>
  notice.kind === "setup" ? (
    <div className="flex items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 font-mono text-[11px] text-warn">
      <ShieldAlertIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{notice.message}</span>
      <button
        onClick={onGrantPermission}
        className="shrink-0 rounded border border-warn/50 px-2 py-0.5 uppercase tracking-wide transition-colors hover:bg-warn/20"
      >
        grant permission
      </button>
    </div>
  ) : notice.kind === "init" ? (
    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 font-mono text-[11px] text-muted-foreground">
      <LoaderIcon className="size-3.5 shrink-0 animate-spin text-primary" />
      <span className="min-w-0 flex-1">{notice.message}</span>
    </div>
  ) : (
    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
      <TriangleAlertIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={notice.message}>
        {notice.message}
      </span>
    </div>
  );
