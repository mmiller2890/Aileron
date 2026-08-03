import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components";

interface DeleteConfirmationDialogProps {
  deleteConfirm: string | null;
  cancelDelete: () => void;
  confirmDelete: () => void;
}

export const DeleteConfirmationDialog = ({
  deleteConfirm,
  cancelDelete,
  confirmDelete,
}: DeleteConfirmationDialogProps) => {
  return (
    <Dialog
      open={!!deleteConfirm}
      onOpenChange={(open) => {
        if (!open) cancelDelete();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete Conversation</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this conversation? This action
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
  );
};
