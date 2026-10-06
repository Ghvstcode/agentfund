import { type ReactNode, useState } from 'react';
import { Dialog as UiDialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface DialogProps {
  title: string;
  onClose: () => void;
  /** `modal` is centred; `drawer` slides over from the right edge for detail views. */
  variant?: 'modal' | 'drawer';
  /** Optional line under the title. */
  subtitle?: ReactNode;
  children: ReactNode;
}

/**
 * A modal surface that is open for as long as it is mounted. Radix handles the focus trap,
 * Escape, the inert page behind and returning focus to whatever opened it.
 */
export function Dialog({ title, onClose, variant = 'modal', subtitle, children }: DialogProps) {
  // The dialog has no Radix trigger (it is mounted by whatever opened it), so remember that
  // element ourselves and hand focus back to it on close.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    opener?.focus();
  };

  if (variant === 'drawer') {
    return (
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-xl" onCloseAutoFocus={restoreFocus}>
          <SheetHeader className="border-b p-5 pr-12">
            <SheetTitle className="text-lg leading-tight font-semibold tracking-tight text-balance">{title}</SheetTitle>
            {subtitle ? <SheetDescription>{subtitle}</SheetDescription> : <SheetDescription className="sr-only">{title}</SheetDescription>}
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <UiDialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 shadow-raised sm:max-w-2xl"
        onCloseAutoFocus={restoreFocus}
      >
        <DialogHeader className="border-b p-5 pr-12">
          <DialogTitle className="text-lg leading-tight font-semibold tracking-tight text-balance">{title}</DialogTitle>
          {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </DialogContent>
    </UiDialog>
  );
}

/** A padded block inside a dialog or sheet; blocks are separated by hairlines. */
export function DialogSection({ title, children, id }: { title?: string; children: ReactNode; id?: string }) {
  return (
    <section aria-labelledby={title && id ? id : undefined} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 border-b p-5 last:border-b-0">
      {title && (
        <h3 id={id} className="text-sm font-semibold tracking-tight">
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}
