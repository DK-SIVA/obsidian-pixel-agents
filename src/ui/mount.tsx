import { createRoot, type Root } from 'react-dom/client'
import App from './App.js'

/**
 * Replaces the desktop app's main.tsx / index.html pair: instead of taking
 * over a whole BrowserWindow, the office is mounted into whatever element
 * the Obsidian view hands us.
 *
 * StrictMode is deliberately not used here. It double-invokes effects, which
 * would start the game loop twice and send `webviewReady` twice.
 */
export function mountOffice(container: HTMLElement): Root {
  const root = createRoot(container)
  root.render(<App />)
  return root
}
