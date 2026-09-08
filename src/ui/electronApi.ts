import type { MessageBus } from '../bus.js';

type MessageCallback = (...args: unknown[]) => void;

/**
 * Drop-in replacement for the desktop app's preload bridge.
 *
 * The whole UI tree imports `api` from this module, so keeping the module
 * path and the shape identical means none of the ported components had to
 * change. Instead of talking to `ipcRenderer`, it talks to the in-process
 * MessageBus the plugin hands over before mounting.
 */
let bus: MessageBus | null = null;

export function setMessageBus(next: MessageBus | null): void {
  bus = next;
}

export const api = {
  send(channel: string, data?: unknown): void {
    bus?.sendToHost(channel, data);
  },
  on(channel: string, callback: MessageCallback): () => void {
    if (!bus) return () => undefined;
    return bus.onView(channel, callback);
  },
  once(channel: string, callback: MessageCallback): void {
    bus?.onceView(channel, callback);
  },
};
