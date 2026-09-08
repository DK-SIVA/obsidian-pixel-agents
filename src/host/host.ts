import type * as fs from 'fs';
import { AgentDiscovery } from './agentDiscovery.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadWallTiles,
} from './assetLoader.js';
import { readNewLines, startFileWatching, stopFileWatching } from './fileWatcher.js';
import type { AgentState, IpcBridge } from './types.js';
import type { MessageBus } from '../bus.js';

/**
 * Everything the host needs from its surroundings. In the Electron app these
 * were files under ~/.pixel-agents and native dialogs; in Obsidian they are
 * plugin data and vault operations, so they are injected rather than imported.
 */
export interface HostAdapter {
  getLayout(): Record<string, unknown> | null;
  saveLayout(layout: Record<string, unknown>): void;
  getSoundEnabled(): boolean;
  setSoundEnabled(enabled: boolean): void;
  getExtraDirLines(): string[];
  exportLayout(layout: Record<string, unknown>): void;
  importLayout(): void;
  openSessionsFolder(): void;
}

/**
 * The former Electron main process, minus the process boundary.
 *
 * Same responsibilities as before: discover session transcripts, tail them,
 * turn them into UI events, and answer the UI's requests. What changed is only
 * where the events go — a MessageBus instead of `webContents.send`.
 */
export class PixelAgentsHost {
  private readonly bus: MessageBus;
  private readonly adapter: HostAdapter;
  private readonly bridge: IpcBridge;

  private discovery: AgentDiscovery | null = null;
  private unsubscribers: Array<() => void> = [];

  private readonly fileWatchers = new Map<number, fs.FSWatcher>();
  private readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  private readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(bus: MessageBus, adapter: HostAdapter) {
    this.bus = bus;
    this.adapter = adapter;
    this.bridge = { send: (channel, data) => this.bus.sendToView(channel, data) };
  }

  /** Wire up the UI -> host channels. The UI kicks things off with `webviewReady`. */
  start(): void {
    this.stop();

    this.listen('webviewReady', () => this.onViewReady());

    this.listen('saveLayout', (data) => {
      const layout = (data as { layout?: Record<string, unknown> })?.layout;
      if (layout) this.adapter.saveLayout(layout);
    });

    this.listen('setSoundEnabled', (data) => {
      const enabled = (data as { enabled?: boolean })?.enabled;
      if (typeof enabled === 'boolean') this.adapter.setSoundEnabled(enabled);
    });

    this.listen('exportLayout', () => {
      const layout = this.adapter.getLayout() ?? loadDefaultLayout();
      if (layout) this.adapter.exportLayout(layout);
    });

    this.listen('importLayout', () => this.adapter.importLayout());

    this.listen('openSessionsFolder', () => this.adapter.openSessionsFolder());

    // Stubs, exactly as in the desktop build: there are no terminals to focus.
    this.listen('focusAgent', () => undefined);
    this.listen('closeAgent', () => undefined);
    this.listen('saveAgentSeats', () => undefined);
    this.listen('installUpdate', () => undefined);
    this.listen('openReleaseUrl', () => undefined);
  }

  /** Called after an import so the office redraws with the new layout. */
  pushLayout(layout: Record<string, unknown>): void {
    this.bus.sendToView('layoutLoaded', { layout });
  }

  stop(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.stopDiscovery();
  }

  private listen(channel: string, handler: (data: unknown) => void): void {
    this.unsubscribers.push(this.bus.onHost(channel, handler as (...args: unknown[]) => void));
  }

  private onViewReady(): void {
    // Order matters: sprites before the layout, layout before discovery.
    const charSprites = loadCharacterSprites();
    if (charSprites) {
      this.bus.sendToView('characterSpritesLoaded', { characters: charSprites.characters });
    }

    const floorTiles = loadFloorTiles();
    if (floorTiles) {
      this.bus.sendToView('floorTilesLoaded', { sprites: floorTiles.sprites });
    }

    const wallTiles = loadWallTiles();
    if (wallTiles) {
      this.bus.sendToView('wallTilesLoaded', { sprites: wallTiles.sprites });
    }

    const furniture = loadFurnitureAssets();
    if (furniture) {
      this.bus.sendToView('furnitureAssetsLoaded', {
        catalog: furniture.catalog,
        sprites: furniture.sprites,
      });
    }

    this.bus.sendToView('settingsLoaded', { soundEnabled: this.adapter.getSoundEnabled() });

    const saved = this.adapter.getLayout();
    this.bus.sendToView('layoutLoaded', { layout: saved ?? loadDefaultLayout() });

    this.startDiscovery();
  }

  private startDiscovery(): void {
    this.stopDiscovery();
    this.discovery = new AgentDiscovery({
      getExtraDirLines: () => this.adapter.getExtraDirLines(),
      onAgentDiscovered: (agent: AgentState) => {
        console.log(`[Pixel Agents] Sending agentCreated for agent ${agent.id}`);
        this.bus.sendToView('agentCreated', { id: agent.id, agentType: agent.agentType });

        const agents = this.discovery!.getAgents();
        startFileWatching(
          agent.id, agent.jsonlFile,
          agents, this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
          this.bridge,
        );

        // Catch up on activity that happened between two scan ticks.
        readNewLines(agent.id, agents, this.waitingTimers, this.permissionTimers, this.bridge);
      },
      onAgentDormant: (agentId: number) => {
        console.log(`[Pixel Agents] Agent ${agentId} went dormant`);
        stopFileWatching(
          agentId, this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
        );
        this.bus.sendToView('agentClosed', { id: agentId });
      },
    });
    this.discovery.start();
  }

  private stopDiscovery(): void {
    if (!this.discovery) return;
    for (const agentId of this.discovery.getAgentIds()) {
      stopFileWatching(
        agentId, this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
      );
    }
    this.discovery.stop();
    this.discovery = null;
  }
}
