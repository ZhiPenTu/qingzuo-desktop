import * as React from 'react';
import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetContent({ className, children, ...props }: SheetPrimitive.Popup.Props) {
  return <SheetPrimitive.Portal>
    <SheetPrimitive.Backdrop data-slot="sheet-overlay" className="fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
    <SheetPrimitive.Popup data-slot="sheet-content" className={cn('fixed inset-y-0 right-0 z-50 flex w-[min(360px,100%)] flex-col gap-3 border-l bg-popover text-popover-foreground shadow-lg transition duration-200 ease-in-out data-ending-style:translate-x-10 data-ending-style:opacity-0 data-starting-style:translate-x-10 data-starting-style:opacity-0', className)} {...props}>
      {children}
      <SheetPrimitive.Close render={<Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" aria-label="关闭面板" />}><X /></SheetPrimitive.Close>
    </SheetPrimitive.Popup>
  </SheetPrimitive.Portal>;
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1.5 p-3.5 pr-9', className)} {...props} />;
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn('text-base font-medium text-foreground', className)} {...props} />;
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription };
