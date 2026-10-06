import { useApp } from "@/contexts";
import { useNavigate } from "react-router-dom";

export const ProviderStatus = () => {
  const { selectedAIProvider, selectedSttProvider } = useApp();
  const navigate = useNavigate();

  const aiModel = selectedAIProvider.variables?.MODEL || "";
  const aiReady = !!selectedAIProvider.provider && !!aiModel;
  const sttReady = !!selectedSttProvider.provider;

  const Row = ({
    label,
    value,
    ready,
  }: {
    label: string;
    value: string;
    ready: boolean;
  }) => (
    <button
      type="button"
      onClick={() => navigate("/dev-space")}
      title="Configure providers"
      className="group flex w-full items-center justify-between font-mono text-xs"
    >
      <span className="text-muted-foreground group-hover:text-foreground">
        {label}
      </span>
      <span className={ready ? "text-ok" : "text-meta group-hover:text-foreground"}>
        <span
          className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
            ready ? "bg-ok" : "bg-meta"
          }`}
        />
        {value}
        {!ready && <span className="ml-1 text-primary">· set up →</span>}
      </span>
    </button>
  );

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="font-mono text-[11px] text-meta">status</div>
      <Row
        label={
          selectedSttProvider.provider === "local-fluidaudio"
            ? "on-device speech"
            : "speech"
        }
        value={selectedSttProvider.provider || "none"}
        ready={sttReady}
      />
      <Row label="model" value={aiReady ? aiModel : "not set"} ready={aiReady} />
    </div>
  );
};
