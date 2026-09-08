/**
 * End-to-end smoke test for the built bundle.
 *
 * Obsidian cannot be scripted from CI, so this test puts the real main.js into
 * a jsdom document with a stubbed `obsidian` module, points it at a throwaway
 * home folder containing a Claude Code transcript, and checks that the plugin
 * does the four things that actually matter:
 *
 *   1. loads and registers its view,
 *   2. decodes the embedded pixel art,
 *   3. mounts the office into the pane,
 *   4. turns new transcript lines into agent events.
 *
 * Run with `npm test` after `npm run build`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sessionFile;
let plugin;
let view;
let container;
const seen = new Map();

function record(channel, data) {
  if (!seen.has(channel)) seen.set(channel, []);
  seen.get(channel).push(data);
}

function firstEvent(channel) {
  return seen.get(channel)?.[0];
}

// ── stubs ─────────────────────────────────────────────────────────────────
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;

  // Obsidian adds these helpers to HTMLElement at runtime.
  window.HTMLElement.prototype.createDiv = function createDiv(options = {}) {
    const div = this.ownerDocument.createElement('div');
    if (options.cls) div.className = options.cls;
    this.appendChild(div);
    return div;
  };
  window.HTMLElement.prototype.empty = function empty() {
    while (this.firstChild) this.removeChild(this.firstChild);
  };

  // jsdom has no canvas backend and no ResizeObserver; the office only needs
  // them to not throw, since nothing here inspects the pixels.
  const noopContext = new Proxy(
    { canvas: null },
    {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        return () => undefined;
      },
      set: () => true,
    },
  );
  window.HTMLCanvasElement.prototype.getContext = () => noopContext;
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.AudioContext = class {
    createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: { value: 0 } }; }
    createGain() { return { connect() {}, gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} } }; }
    get destination() { return {}; }
    get currentTime() { return 0; }
    resume() { return Promise.resolve(); }
    get state() { return 'running'; }
  };

  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'CustomEvent', 'FileReader', 'ResizeObserver',
    'AudioContext', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DOMRect',
  ]) {
    if (window[key] === undefined) continue;
    // Some of these (navigator) are getter-only on globalThis in Node 22.
    try {
      Object.defineProperty(globalThis, key, {
        value: window[key], configurable: true, writable: true,
      });
    } catch {
      // Node's own implementation is close enough — keep going.
    }
  }
  globalThis.self = window;
  return dom;
}

function makeObsidianStub() {
  class Notice {
    constructor(message) {
      this.message = message;
    }
  }

  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this._data = null;
      this.views = new Map();
      this.commands = [];
      this.settingTabs = [];
      this.ribbonIcons = [];
    }
    registerView(type, factory) { this.views.set(type, factory); }
    addRibbonIcon(icon, title, callback) { this.ribbonIcons.push({ icon, title, callback }); return {}; }
    addCommand(command) { this.commands.push(command); return command; }
    addSettingTab(tab) { this.settingTabs.push(tab); }
    registerDomEvent(el, type, callback) { el.addEventListener(type, callback); }
    registerEvent() {}
    register() {}
    async loadData() { return this._data; }
    async saveData(data) { this._data = data; }
  }

  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.containerEl = document.createElement('div');
      this.contentEl = document.createElement('div');
      this.containerEl.appendChild(this.contentEl);
      document.body.appendChild(this.containerEl);
    }
    registerDomEvent(el, type, callback) { el.addEventListener(type, callback); }
    registerEvent() {}
    register() {}
  }

  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = document.createElement('div');
    }
  }

  const chainable = () => new Proxy(function noop() {}, {
    get: () => chainable(),
    apply: () => chainable(),
  });

  class Setting {
    constructor() { return chainable(); }
  }

  class WorkspaceLeaf {}

  return {
    Notice, Plugin, ItemView, PluginSettingTab, Setting, WorkspaceLeaf,
    normalizePath: (p) => p,
  };
}

function makeAppStub() {
  return {
    workspace: {
      getLeavesOfType: () => [],
      getLeaf: () => null,
      getRightLeaf: () => null,
      getLeftLeaf: () => null,
      revealLeaf: async () => undefined,
    },
    vault: {
      adapter: {
        write: async () => undefined,
      },
    },
  };
}

// ── setup ─────────────────────────────────────────────────────────────────
before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'pixel-agents-home-'));
  const projectDir = join(home, '.claude', 'projects', '-test-vault');
  mkdirSync(projectDir, { recursive: true });
  sessionFile = join(projectDir, 'session-under-test.jsonl');
  // A transcript that already exists when discovery starts: the agent must be
  // picked up, but only lines appended afterwards drive the animation.
  writeFileSync(sessionFile, JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  installDom();

  const obsidian = makeObsidianStub();
  const electron = { shell: { openPath: async () => '' } };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'obsidian') return obsidian;
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, ...rest);
  };

  const require = createRequire(import.meta.url);
  const bundle = require(join(repoRoot, 'main.js'));
  const PixelAgentsPlugin = bundle.default ?? bundle;

  plugin = new PixelAgentsPlugin(makeAppStub(), { id: 'pixel-agents', version: 'test' });
  await plugin.onload();

  for (const channel of [
    'characterSpritesLoaded', 'floorTilesLoaded', 'wallTilesLoaded', 'furnitureAssetsLoaded',
    'settingsLoaded', 'layoutLoaded', 'agentCreated', 'agentClosed', 'agentToolStart',
    'agentToolDone', 'agentStatus', 'subagentClear', 'agentToolPermission',
  ]) {
    plugin.bus.onView(channel, (data) => record(channel, data));
  }

  const factory = plugin.views.get('pixel-agents-office');
  assert.ok(factory, 'the plugin registered its view type');
  view = factory(new obsidian.WorkspaceLeaf());
  await view.onOpen();
  container = view.contentEl.querySelector('.pixel-agents-view');

  // Let React mount and the first discovery tick run (scan interval is 2s).
  await sleep(3000);
});

after(async () => {
  await view?.onClose();
  plugin?.onunload();
});

// ── tests ─────────────────────────────────────────────────────────────────
test('the office pane is created and focusable', () => {
  assert.ok(container, 'view content holds a .pixel-agents-view element');
  assert.equal(container.tabIndex, -1, 'pane is focusable so shortcuts stay local');
});

test('embedded character sprites decode to the expected shape', () => {
  const event = firstEvent('characterSpritesLoaded');
  assert.ok(event, 'characterSpritesLoaded was sent');
  assert.equal(event.characters.length, 6, 'six character sheets');
  assert.equal(event.characters[0].down.length, 7, 'seven walk frames per direction');
  assert.equal(event.characters[0].down[0].length, 32, 'frames are 32 rows tall');
  assert.equal(event.characters[0].down[0][0].length, 16, 'frames are 16 pixels wide');
  const pixels = event.characters[0].down[0].flat();
  assert.ok(
    pixels.some((p) => /^#[0-9A-F]{6}$/.test(p)),
    'sprite contains real colour values, not just transparency',
  );
});

test('tiles and the full furniture catalog are available', () => {
  assert.equal(firstEvent('wallTilesLoaded').sprites.length, 16, '16 wall bitmask pieces');
  assert.equal(firstEvent('floorTilesLoaded').sprites.length, 7, '7 floor patterns');
  const furniture = firstEvent('furnitureAssetsLoaded');
  assert.equal(furniture.catalog.length, 92, 'catalog is complete');
  assert.equal(
    Object.keys(furniture.sprites).length, 92,
    'every catalog entry has a decoded sprite',
  );
});

test('the default layout is handed to the UI', () => {
  const event = firstEvent('layoutLoaded');
  assert.ok(event?.layout, 'layoutLoaded carries a layout');
  assert.equal(event.layout.version, 1);
  assert.ok(Array.isArray(event.layout.tiles) && event.layout.tiles.length > 0);
});

test('React renders the office canvas into the pane', () => {
  assert.ok(container.querySelector('canvas'), 'a canvas was rendered');
});

test('an existing transcript is discovered as an agent', () => {
  const created = firstEvent('agentCreated');
  assert.ok(created, 'agentCreated was sent for the pre-existing transcript');
  assert.equal(created.agentType, 'claude');
});

test('appended tool calls become agent events', async () => {
  appendFileSync(
    sessionFile,
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_smoke_1', name: 'Read', input: { file_path: '/vault/Note.md' } },
        ],
      },
    }) + '\n',
  );
  await sleep(2500);

  const start = firstEvent('agentToolStart');
  assert.ok(start, 'agentToolStart was sent');
  assert.match(String(start.status ?? ''), /Note\.md/, 'status names the file being read');

  appendFileSync(
    sessionFile,
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_smoke_1' }] },
    }) + '\n',
  );
  await sleep(2500);

  assert.ok(firstEvent('agentToolDone'), 'agentToolDone was sent once the tool finished');
});

test('parallel sub-agents each get a character', async () => {
  // Current Claude Code names the sub-agent tool "Agent", not "Task". Both have
  // to produce the "Subtask:" status, because that prefix is what makes the UI
  // spawn a sub-agent character.
  for (const [id, description] of [
    ['toolu_agent_a', 'research switches'],
    ['toolu_agent_b', 'check datasheets'],
  ]) {
    appendFileSync(
      sessionFile,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id, name: 'Agent', input: { description, subagent_type: 'general-purpose' } }],
        },
      }) + '\n',
    );
  }
  await sleep(2500);

  const subtasks = (seen.get('agentToolStart') ?? []).filter(
    (event) => String(event.status ?? '').startsWith('Subtask:'),
  );
  assert.equal(subtasks.length, 2, 'both Agent calls announce themselves as subtasks');
  assert.deepEqual(
    subtasks.map((event) => event.status).sort(),
    ['Subtask: check datasheets', 'Subtask: research switches'],
    'each character is labelled with its own description',
  );

  // A sub-agent run takes minutes; it must not raise a permission bubble.
  assert.equal(
    seen.get('agentToolPermission'), undefined,
    'a running Agent call is not mistaken for waiting on the user',
  );

  appendFileSync(
    sessionFile,
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_a' }] },
    }) + '\n',
  );
  await sleep(2500);

  const cleared = seen.get('subagentClear') ?? [];
  assert.equal(cleared.length, 1, 'the finished sub-agent character is removed');
  assert.equal(cleared[0].parentToolId, 'toolu_agent_a', 'and only that one');
});
