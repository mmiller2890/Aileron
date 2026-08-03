import { UseSettingsReturn } from "@/types";
import {
  Card,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Header,
} from "@/components";
import { EditIcon, TrashIcon } from "lucide-react";
import { CreateEditProvider } from "./CreateEditProvider";
import { useCustomAiProviders } from "@/hooks";
import curl2Json from "@bany/curl-to-json";

export const CustomProviders = ({ allAiProviders }: UseSettingsReturn) => {
  const customProviderHook = useCustomAiProviders();
  const {
    handleEdit,
    handleDelete,
    deleteConfirm,
    confirmDelete,
    cancelDelete,
  } = customProviderHook;

  return (
    <div className="space-y-2">
      <Header
        title="Custom Providers"
        description="Create and manage custom AI providers. Configure endpoints, authentication, and response formats."
      />

      <div className="space-y-2">
        {/* Existing Custom Providers */}
        {allAiProviders.filter((provider) => provider?.isCustom).length > 0 && (
          <div className="space-y-2">
            {allAiProviders
              .filter((provider) => provider?.isCustom)
              .map((provider) => {
                const json = curl2Json(provider?.curl);

                return (
                  <Card
                    key={provider?.id}
                    className="p-3 border !bg-transparent border-input/50"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h4 className="font-medium text-sm">
                          {json?.url || "Invalid curl command"}
                        </h4>

                        <div className="flex items-center gap-2 mt-1">
                          <p className="text-xs text-muted-foreground">
                            {`Response Path: ${
                              provider?.responseContentPath || "Not set"
                            }`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {" • "}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Streaming: {provider?.streaming ? "Yes" : "No"}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            provider?.id && handleEdit(provider?.id)
                          }
                          title="Edit Provider"
                        >
                          <EditIcon className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            provider?.id && handleDelete(provider?.id)
                          }
                          title="Delete Provider"
                          className="text-destructive hover:text-destructive"
                        >
                          <TrashIcon className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })}
          </div>
        )}
      </div>
      <CreateEditProvider customProviderHook={customProviderHook} />

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteConfirm}
        onOpenChange={(open) => {
          if (!open) cancelDelete();
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete Custom Provider</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this custom provider? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancelDelete}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
