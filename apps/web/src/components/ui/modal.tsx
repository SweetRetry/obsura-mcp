import { Button } from "@workspace/ui/components/button"
import { XIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"

import { EASE } from "@/lib/ease"

const MORPH = { duration: 0.3, ease: EASE }

/**
 * A panel nearly the size of the window, over the view it was opened from: a header bar with the
 * title, `meta` and the close button, and below it the children, which fill the rest and scroll
 * their own regions. Given the `layoutId` of the element that opened it, the panel grows out of
 * that element and shrinks back into it. The native dialog supplies the focus trap and the inert
 * page behind. Escape is
 * handled here, since a browser closes a dialog outright on a second Escape and would skip the exit.
 * `onClosed` runs once the panel is gone.
 */
export function Modal({
  layoutId,
  title,
  meta,
  onClosed,
  children,
}: {
  layoutId?: string
  title: string
  meta?: ReactNode
  onClosed: () => void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [open, setOpen] = useState(true)
  const close = () => setOpen(false)
  useEffect(() => dialog.current?.showModal(), [])

  return (
    <motion.dialog
      ref={dialog}
      aria-labelledby={titleId}
      className="fixed inset-0 m-0 size-full max-h-none max-w-none overflow-hidden bg-transparent p-2 text-foreground backdrop:bg-transparent sm:p-6"
      closedby="none"
      onCancel={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const viewerIsOpen = dialog.current?.querySelector(".yarl__portal")
        if (event.key === "Escape" && !viewerIsOpen) close()
      }}
      onClose={onClosed}
    >
      <AnimatePresence onExitComplete={onClosed}>
        {open && (
          <motion.div
            key="backdrop"
            aria-hidden
            className="fixed inset-0 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          />
        )}
        {open && (
          <motion.div
            key="panel"
            layoutId={layoutId}
            className="relative mx-auto h-full w-full max-w-7xl overflow-hidden border bg-background"
            style={{ borderRadius: 10 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={MORPH}
          >
            <motion.div layout="position" className="flex h-full flex-col" transition={MORPH}>
              <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
                <h2 id={titleId} className="text-sm font-medium">
                  {title}
                </h2>
                {meta}
                <span className="flex-1" />
                <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={close}>
                  <XIcon />
                </Button>
              </header>
              {children}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.dialog>
  )
}
