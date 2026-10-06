import { Loader2, TrashIcon } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Header,
} from "@/components";
import { UseSettingsReturn } from "@/types";
import { useState } from "react";

export const DeleteChats = ({
  handleDeleteAllChatsConfirm,
  showDeleteConfirmDialog,
  setShowDeleteConfirmDialog,
}: UseSettingsReturn) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [outcome, setOutcome] = useState<"deleted" | "failed" | null>(null);

  const deleteAllChats = async () => {
    setIsDeleting(true);
    setOutcome(null);
    const deleted = await handleDeleteAllChatsConfirm();
    setIsDeleting(false);
    setOutcome(deleted ? "deleted" : "failed");
  };

  return (
    <div id="delete-chats" className="space-y-3">
      <Header
        title="Delete Chat History"
        description="Permanently delete all your chat conversations and history. This action cannot be undone and will remove all stored conversations from your local storage."
        isMainTitle
      />

      <div className="space-y-2">
        {outcome === "deleted" && (
          <div className="p-3 bg-ok/10 border border-ok/30 rounded-md">
            <p className="text-xs text-ok font-medium">
              All chat history has been deleted.
            </p>
          </div>
        )}
        {outcome === "failed" && (
          <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-md">
            <p className="text-xs text-destructive font-medium">
              The chat history could not be deleted. Nothing was removed; try
              again.
            </p>
          </div>
        )}

        <Button
          onClick={() => setShowDeleteConfirmDialog(true)}
          disabled={isDeleting}
          variant="destructive"
          className="w-full h-11"
          title="Delete all chat history"
        >
          {isDeleting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Deleting...
            </>
          ) : (
            <>
              <TrashIcon className="h-4 w-4 mr-2" />
              Delete All Chats
            </>
          )}
        </Button>
      </div>

      {/* Confirmation Dialog */}
      <Dialog
        open={showDeleteConfirmDialog}
        onOpenChange={setShowDeleteConfirmDialog}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete All Chat History</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete all chat history? This action
              cannot be undone and will permanently remove all stored
              conversations.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirmDialog(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteAllChats}>
              Delete All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
