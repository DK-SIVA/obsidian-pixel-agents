export type BusCallback = (...args: unknown[]) => void;

/**
 * In-process stand-in for Electron's ipcMain/ipcRenderer pair.
 *
 * The desktop app split the work across two processes: the main process
 * scanned transcripts and pushed events into a BrowserWindow, the renderer
 * drew the office. Inside Obsidian both halves live in the same process, so
 * the two directions are just two channel maps.
 *
 * - "view" channels carry host -> UI events (agentCreated, layoutLoaded, ...)
 * - "host" channels carry UI -> host requests (webviewReady, saveLayout, ...)
 */
export class MessageBus {
  private viewChannels = new Map<string, Set<BusCallback>>();
  private hostChannels = new Map<string, Set<BusCallback>>();

  /** Host -> UI. Mirrors `mainWindow.webContents.send()`. */
  sendToView(channel: string, data?: unknown): void {
    emit(this.viewChannels, channel, data ?? {});
  }

  /** UI -> host. Mirrors `ipcRenderer.send()`. */
  sendToHost(channel: string, data?: unknown): void {
    emit(this.hostChannels, channel, data ?? {});
  }

  /** UI subscribes. Returns an unsubscribe function, like the old preload did. */
  onView(channel: string, callback: BusCallback): () => void {
    return subscribe(this.viewChannels, channel, callback);
  }

  onceView(channel: string, callback: BusCallback): void {
    const off = subscribe(this.viewChannels, channel, (...args) => {
      off();
      callback(...args);
    });
  }

  /** Host subscribes. Mirrors `ipcMain.on()`. */
  onHost(channel: string, callback: BusCallback): () => void {
    return subscribe(this.hostChannels, channel, callback);
  }

  clear(): void {
    this.viewChannels.clear();
    this.hostChannels.clear();
  }
}

function subscribe(
  channels: Map<string, Set<BusCallback>>,
  channel: string,
  callback: BusCallback,
): () => void {
  let set = channels.get(channel);
  if (!set) {
    set = new Set();
    channels.set(channel, set);
  }
  set.add(callback);
  return () => {
    channels.get(channel)?.delete(callback);
  };
}

function emit(
  channels: Map<string, Set<BusCallback>>,
  channel: string,
  data: unknown,
): void {
  const set = channels.get(channel);
  if (!set) return;
  // Copy first: a handler may subscribe or unsubscribe while we iterate.
  for (const callback of [...set]) {
    try {
      callback(data);
    } catch (err) {
      console.error(`[Pixel Agents] handler for "${channel}" threw:`, err);
    }
  }
}
