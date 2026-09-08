import { MAX_DELTA_TIME_SEC } from '../../constants.js'

export interface GameLoopCallbacks {
  update: (dt: number) => void
  render: (ctx: CanvasRenderingContext2D) => void
}

export function startGameLoop(
  canvas: HTMLCanvasElement,
  callbacks: GameLoopCallbacks,
): () => void {
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false

  let lastTime = 0
  let rafId = 0
  let stopped = false

  const frame = (time: number) => {
    if (stopped) return

    // Inside Obsidian the office shares a process with the editor, and a pane
    // sitting in a background tab stays in the DOM while still being offered
    // frames. Skip the work while it is off screen and restart the clock, so
    // the characters do not jump ahead when the pane comes back.
    if (canvas.offsetParent === null) {
      lastTime = 0
      rafId = requestAnimationFrame(frame)
      return
    }

    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC)
    lastTime = time

    callbacks.update(dt)

    ctx.imageSmoothingEnabled = false
    callbacks.render(ctx)

    rafId = requestAnimationFrame(frame)
  }

  rafId = requestAnimationFrame(frame)

  return () => {
    stopped = true
    cancelAnimationFrame(rafId)
  }
}
