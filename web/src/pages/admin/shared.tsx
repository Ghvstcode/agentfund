import type { ReactNode } from 'react';
import { Button } from '@/components/Button';
import { describeError } from '@/components/States';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Column heading style shared by the admin tables. */
export const COLUMN = 'h-9 text-xs font-medium text-muted-foreground';

interface ConfirmDialogProps {
  title: string;
  /** What happens if the admin goes ahead. */
  consequence: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

/** The second step of a destructive action: says what will happen before it does. */
export function ConfirmDialog({ title, consequence, confirmLabel, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="shadow-raised">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">{title}</DialogTitle>
          <DialogDescription className="text-pretty">{consequence}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RowError({ error }: { error: unknown }) {
  return (
    <span className="mt-1 block text-xs font-medium whitespace-normal text-destructive" role="alert">
      {describeError(error)}
    </span>
  );
}
