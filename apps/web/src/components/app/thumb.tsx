import { FilmIcon, ImageOffIcon, MusicIcon } from "lucide-react"
import { motion } from "motion/react"

import { GenerationOverlay } from "@/components/ui/generation-overlay"

type Output = { url: string; mime: string }

/**
 * A task's first output as a square. An open task with nothing yet shows the generating flow; a
 * video or audio output, or a finished task with none, shows an icon in its place, so a grid of
 * mixed tasks keeps its rhythm. `layoutId` is the one the task's modal grows out of.
 */
export function Thumb({
  id,
  layoutId,
  prompt,
  outputs,
  pending,
  className,
}: {
  id: string
  layoutId: string
  prompt: string
  outputs: Output[]
  pending: boolean
  className: string
}) {
  const first = outputs[0]
  if (pending && !first)
    return (
      <motion.div layoutId={layoutId} className={className}>
        <GenerationOverlay id={id} pending />
      </motion.div>
    )
  const Icon = !first ? ImageOffIcon : first.mime.startsWith("video/") ? FilmIcon : MusicIcon
  return (
    <motion.div
      layoutId={layoutId}
      className={`flex items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground ${className}`}
    >
      {first?.mime.startsWith("image/") ? (
        <img src={first.url} alt={prompt} loading="lazy" className="size-full object-cover" />
      ) : (
        <Icon className="size-1/3 max-w-8" aria-hidden />
      )}
    </motion.div>
  )
}
