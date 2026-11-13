import { useNavigate } from "react-router-dom";
import { Button, Header } from "@/components";

/** Reopens the first-launch checklist on the dashboard's starting screen. */
export const SetupGuide = () => {
  const navigate = useNavigate();
  return (
    <div id="setup-guide" className="space-y-2">
      <Header
        title="Setup Guide"
        description="Walk through audio access, your AI provider and the speech models again"
        isMainTitle
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate("/dashboard", { state: { setup: true } })}
      >
        Open setup guide
      </Button>
    </div>
  );
};
