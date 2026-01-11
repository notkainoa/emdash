import { useState } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Spinner } from './ui/spinner';
import { AlertCircle, GitFork } from 'lucide-react';

interface ForkConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  repoName?: string;
}

export function ForkConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  repoName,
}: ForkConfirmationModalProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setIsCreating(true);
    setError(null);
    try {
      await onConfirm();
      // Modal will be closed by parent after success
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to create fork';
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    // Prevent closing during async operations
    if (!open && isCreating) {
      return;
    }
    if (!open) {
      onClose();
      setError(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitFork className="h-5 w-5" />
            Create Fork?
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!isCreating && !error && (
            <>
              <p className="text-sm text-muted-foreground">
                You don't have write access to {repoName ? `the repository "${repoName}"` : 'this repository'}.{' '}
                Would you like to create a fork so you can open a pull request?
              </p>
              <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <p>
                  This will create a fork under your GitHub account. Your changes will be pushed to the
                  fork, and you'll be able to open a pull request from there.
                </p>
              </div>
            </>
          )}

          {isCreating && (
            <div className="flex items-center gap-3 py-4">
              <Spinner size="sm" />
              <div className="flex-1">
                <p className="text-sm font-medium">Creating fork...</p>
                <p className="text-xs text-muted-foreground">This may take a few moments...</p>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {!isCreating && (
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" onClick={handleConfirm}>
                Create Fork
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
