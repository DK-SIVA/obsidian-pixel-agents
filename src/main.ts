import { ItemView, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, normalizePath } from 'obsidian';
import type { Root } from 'react-dom/client';
import * as os from 'os';
import * as path from 'path';
import { MessageBus } from './bus.js';
import { PixelAgentsHost, type HostAdapter } from './host/host.js';
import { CLAUDE_PROJECTS_DIR } from './host/constants.js';
import { setMessageBus } from './ui/electronApi.js';
import { mountOffice } from './ui/mount.js';

export const VIEW_TYPE_PIXEL_AGENTS = 'pixel-agents-office';

type OpenLocation = 'tab' | 'right' | 'left';

interface PixelAgentsSettings {
  soundEnabled: boolean;
  /** Free-form, one folder per line — see AgentDiscovery.readExtraDirs(). */
  extraDirs: string;
  openIn: OpenLocation;
  /** The office itself. Lives in data.json instead of ~/.pixel-agents/layout.json. */
  layout: Record<string, unknown> | null;
}

const DEFAULT_SETTINGS: PixelAgentsSettings = {
  soundEnabled: true,
  extraDirs: '',
  openIn: 'tab',
  layout: null,
};

const EXPORT_FILE = 'pixel-agents-layout.json';
const LAYOUT_SAVE_DEBOUNCE_MS = 250;

export default class PixelAgentsPlugin extends Plugin {
  settings: PixelAgentsSettings = { ...DEFAULT_SETTINGS };
  bus: MessageBus = new MessageBus();
  host: PixelAgentsHost | null = null;

  private layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.host = new PixelAgentsHost(this.bus, this.createAdapter());

    this.registerView(
      VIEW_TYPE_PIXEL_AGENTS,
      (leaf) => new PixelAgentsView(leaf, this),
    );

    this.addRibbonIcon('users', 'Pixel Agents', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-office',
      name: 'Open office',
      callback: () => {
        void this.activateView();
      },
    });

    this.addSettingTab(new PixelAgentsSettingTab(this));
  }

  onunload(): void {
    if (this.layoutSaveTimer) clearTimeout(this.layoutSaveTimer);
    this.host?.stop();
    this.bus.clear();
    setMessageBus(null);
  }

  /** Only ever one office: a second view would fight over the shared game state. */
  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PIXEL_AGENTS);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    let leaf: WorkspaceLeaf | null;
    if (this.settings.openIn === 'right') {
      leaf = this.app.workspace.getRightLeaf(false);
    } else if (this.settings.openIn === 'left') {
      leaf = this.app.workspace.getLeftLeaf(false);
    } else {
      leaf = this.app.workspace.getLeaf('tab');
    }
    if (!leaf) return;

    await leaf.setViewState({ type: VIEW_TYPE_PIXEL_AGENTS, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private createAdapter(): HostAdapter {
    return {
      getLayout: () => this.settings.layout,
      saveLayout: (layout) => this.queueLayoutSave(layout),
      getSoundEnabled: () => this.settings.soundEnabled,
      setSoundEnabled: (enabled) => {
        this.settings.soundEnabled = enabled;
        void this.saveSettings();
      },
      getExtraDirLines: () => this.settings.extraDirs.split(/\r?\n/),
      exportLayout: (layout) => {
        void this.exportLayout(layout);
      },
      importLayout: () => this.importLayout(),
      openSessionsFolder: () => {
        void this.openSessionsFolder();
      },
    };
  }

  /**
   * The editor saves after every change. Writing data.json that often is
   * wasteful, so collapse bursts into one write.
   */
  private queueLayoutSave(layout: Record<string, unknown>): void {
    this.settings.layout = layout;
    if (this.layoutSaveTimer) clearTimeout(this.layoutSaveTimer);
    this.layoutSaveTimer = setTimeout(() => {
      this.layoutSaveTimer = null;
      void this.saveSettings();
    }, LAYOUT_SAVE_DEBOUNCE_MS);
  }

  private async exportLayout(layout: Record<string, unknown>): Promise<void> {
    const target = normalizePath(EXPORT_FILE);
    try {
      await this.app.vault.adapter.write(target, JSON.stringify(layout, null, 2));
      new Notice(`Pixel Agents: layout written to ${target}`);
    } catch (err) {
      new Notice(`Pixel Agents: could not write ${target}`);
      console.error('[Pixel Agents] export failed', err);
    }
  }

  /**
   * Replaces Electron's native open dialog. A plain file input works inside
   * Obsidian and lets the layout come from anywhere, not just the vault.
   */
  private importLayout(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        try {
          const imported = JSON.parse(String(reader.result)) as Record<string, unknown>;
          if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
            new Notice('Pixel Agents: not a valid layout file');
            return;
          }
          this.settings.layout = imported;
          void this.saveSettings();
          this.host?.pushLayout(imported);
          new Notice('Pixel Agents: layout imported');
        } catch {
          new Notice('Pixel Agents: could not read that layout file');
        }
      });
      reader.readAsText(file);
    });
    input.click();
  }

  private async openSessionsFolder(): Promise<void> {
    const dir = path.join(os.homedir(), CLAUDE_PROJECTS_DIR);
    try {
      const { shell } = await import('electron');
      const error = await shell.openPath(dir);
      if (error) new Notice(`Pixel Agents: ${error}`);
    } catch {
      new Notice(`Pixel Agents: ${dir}`);
    }
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PixelAgentsSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class PixelAgentsView extends ItemView {
  private readonly plugin: PixelAgentsPlugin;
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PixelAgentsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PIXEL_AGENTS;
  }

  getDisplayText(): string {
    return 'Pixel Agents';
  }

  getIcon(): string {
    return 'users';
  }

  async onOpen(): Promise<void> {
    const host = this.contentEl.createDiv({ cls: 'pixel-agents-view' });
    // Focusable so the editor's keyboard shortcuts only fire while this pane
    // has focus, instead of hijacking keys typed into a note.
    host.tabIndex = -1;
    this.registerDomEvent(host, 'pointerdown', () => host.focus());

    setMessageBus(this.plugin.bus);
    this.plugin.host?.start();
    this.root = mountOffice(host);
  }

  async onClose(): Promise<void> {
    this.plugin.host?.stop();
    this.root?.unmount();
    this.root = null;
    setMessageBus(null);
    this.plugin.bus.clear();
    this.contentEl.empty();
  }
}

class PixelAgentsSettingTab extends PluginSettingTab {
  private readonly plugin: PixelAgentsPlugin;

  constructor(plugin: PixelAgentsPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Notification sounds')
      .setDesc('Play a chime when an agent needs your attention.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.soundEnabled).onChange(async (value) => {
          this.plugin.settings.soundEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Open office in')
      .setDesc('Where the ribbon icon and the command put the view.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('tab', 'New tab')
          .addOption('right', 'Right sidebar')
          .addOption('left', 'Left sidebar')
          .setValue(this.plugin.settings.openIn)
          .onChange(async (value) => {
            this.plugin.settings.openIn = value as OpenLocation;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Additional transcript folders')
      .setDesc(
        'One folder per line, scanned in addition to ~/.claude/projects and ~/.codex/sessions. ' +
        'Use this if CLAUDE_CONFIG_DIR points elsewhere, or to watch transcripts mirrored from ' +
        'another machine. "#" starts a comment, an optional "codex:" prefix marks Codex ' +
        'transcripts, and %USERPROFILE% or a leading ~ expands to your home folder. ' +
        'Changes take effect within a few seconds.',
      )
      .addTextArea((area) => {
        area
          .setPlaceholder('%USERPROFILE%\\Downloads\\remote-agents\n\\\\OTHER-PC\\Users\\me\\.claude\\projects')
          .setValue(this.plugin.settings.extraDirs)
          .onChange(async (value) => {
            this.plugin.settings.extraDirs = value;
            await this.plugin.saveSettings();
          });
        area.inputEl.rows = 5;
        area.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('Stored layout')
      .setDesc('Forget the saved office and go back to the default arrangement.')
      .addButton((button) =>
        button
          .setButtonText('Reset layout')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.layout = null;
            await this.plugin.saveSettings();
            new Notice('Pixel Agents: layout reset — reopen the office to see it');
          }),
      );
  }
}
