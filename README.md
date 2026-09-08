# Pixel Agents for Obsidian

Your Claude Code and Codex sessions as animated pixel art characters, in a pane inside Obsidian.

The plugin watches the session transcripts those tools write to disk
(`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`) and turns them into a little
office: one character per live session, typing when the agent writes a file, reading when it
reads one, waiting at the desk when it wants your permission, and spawning sub-agents in a
shower of green rain when a `Task` starts.

It pairs with [Claudian](https://github.com/YishenTu/claudian), which runs Claude Code inside
Obsidian with your vault as the working directory. Claudian spawns the real Claude CLI, so its
sessions land in the same transcript folder this plugin watches — no configuration needed. It
works just as well with a plain `claude` in a terminal, or with Codex.

> ### ⚠️ This project is entirely vibe-coded
>
> Every file in this repository — the port, the build pipeline, the tests, this README — was
> written by **Claude Opus 5** in a single Anthropic Cowork session, from the instruction "port
> Pixel Agents to an Obsidian plugin". No line of it was typed by a human, and no human has
> reviewed it line by line. It compiles, it type-checks, and an automated smoke test drives the
> real bundle against a real transcript (see [Tests](#tests)) — but that is the extent of the
> quality assurance. Read the source before you trust it with anything, and treat every bug as
> expected rather than surprising.

## Install

Not in the community plugin store. Use
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable BRAT from the community plugins.
2. `BRAT: Add a beta plugin for testing` → `DK-SIVA/obsidian-pixel-agents`.
3. Enable **Pixel Agents** in Community plugins.

Manual install works too: drop `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/DK-SIVA/obsidian-pixel-agents/releases) into
`<vault>/.obsidian/plugins/pixel-agents/`.

Desktop only. The plugin reads files outside the vault and needs Node APIs, which Obsidian
mobile does not provide.

## Use

Open the office with the ribbon icon (👥) or the command **Pixel Agents: Open office**. Start a
Claude Code or Codex session anywhere on the machine and a character walks in within a couple of
seconds.

The bottom toolbar toggles **edit mode**, where the office becomes a furniture editor: drag
items, paint floors and walls, recolour pieces, and undo with `Ctrl+Z`. Keyboard shortcuts only
fire while the office pane has focus, so typing an `r` into a note will not rotate your desk.

When a session spawns sub-agents — Claude Code's `Agent` tool, older builds' `Task` — each
running one walks in as its own character with the call's description as its label, and leaves
again when it finishes. Six agents working in parallel means six extra characters.

The **Settings** button next to it opens the office's own panel: sound on/off, a debug view
listing every tracked session (the quickest way to see whether a transcript is being picked up at
all), layout import/export, and a shortcut that opens `~/.claude/projects` in your file manager.

### Settings

| Setting | What it does |
| --- | --- |
| Notification sounds | Chime when an agent asks for permission. |
| Open office in | New tab, right sidebar or left sidebar. |
| Additional transcript folders | Extra folders to scan, one per line. |
| Reset layout | Forget the saved office and return to the default arrangement. |

**Additional transcript folders** covers the two cases the default paths miss. If you point
`CLAUDE_CONFIG_DIR` somewhere else — Claudian lets you set it per provider — add that folder's
`projects` subfolder. And if you mirror transcripts from another machine (a `robocopy` from a
second PC, or a sync folder), add the target folder. Syntax:

```
# a folder on this machine
%USERPROFILE%\Downloads\remote-agents

# a network share on the PC where Claude Code actually runs
\\OTHER-PC\Users\me\.claude\projects

# Codex transcripts live in a different format — mark them
codex:D:\mirror\codex-sessions
```

`#` starts a comment, `%USERPROFILE%` and a leading `~` expand to your home folder, and each
folder is scanned one level deep. Changes take effect within a few seconds; no restart.

### Layouts

Import and export live in the office's own **Settings** panel (bottom toolbar), not in
Obsidian's plugin settings. Export writes `pixel-agents-layout.json` to your vault root; import takes a
JSON file from anywhere. The office itself is stored in the plugin's `data.json`, so it travels
with the vault and not with the machine.

## What changed from the desktop app

This is a port of [pixel-agents-desktop](https://github.com/Dsantiagomj/pixel-agents-desktop),
not a rewrite. The game engine — the office, characters, pathfinding, sprites, the editor — is
the upstream code, unchanged. What had to be replaced is the shell around it:

| Desktop app | This plugin |
| --- | --- |
| Two Electron processes with `ipcMain`/`ipcRenderer` | One process, an in-memory `MessageBus` (`src/bus.ts`) |
| Own `BrowserWindow` | An Obsidian `ItemView` in a pane |
| Sprites read from disk next to the executable | Same PNGs, base64-baked into `main.js` (`scripts/gen-assets.mjs`) |
| `~/.pixel-agents/layout.json`, `settings.json` | The plugin's `data.json` via `loadData`/`saveData` |
| Native open/save dialogs | Vault write for export, a file input for import |
| Extra watch folders from `extra-dirs.txt` | The settings field above |
| System tray, auto-updater, window bounds | Dropped — Obsidian and BRAT own those |
| Global `keydown` listener | Bound to the office pane, so shortcuts stay local |
| Sub-agents only via `Task` and `progress` records | Also `Agent`, derived from the parent's tool calls |
| Game loop always running | Skips frames while the pane is off screen |

`src/ui/electronApi.ts` keeps the module path and the exact shape of the old preload bridge, so
the ~8,000 lines of UI code did not need to be touched to talk to the new bus.

### Known limitations

- A session with no new transcript lines for five minutes is treated as dormant and its
  character leaves. When the session picks up again it comes back as a *new* agent, which may
  get a different sprite. That is upstream behaviour, not a bug introduced here.
- Only one office pane at a time. The game state is a module-level singleton upstream; a second
  pane would fight over it, so opening the view again just reveals the existing one.
- The "agent needs permission" state is inferred from a pause in the transcript, so it can be
  wrong in both directions.
- Clicking a character does nothing. In VS Code it focused that agent's terminal; there is no
  terminal to focus here.
- A sub-agent's character shows that it is running, not what it is doing. Upstream read that
  from transcript records of type `progress` carrying `parentToolUseID`; current Claude Code no
  longer writes them, so the individual steps inside a sub-agent are simply not on disk. The
  characters themselves are derived from the parent session's `Agent` / `Task` calls instead,
  which is why they work at all.

## Development

```bash
npm install
npm run build     # generate assets, type-check, bundle to main.js
npm run dev       # same, but esbuild in watch mode
npm test          # smoke test against the built bundle
```

`npm run assets` regenerates `src/assets/assetData.ts` and `styles.css` from `assets/`. Both are
generated and git-ignored in source form: `styles.css` and `main.js` are committed because BRAT
installs them straight from the repository.

### Tests

`tests/smoke.test.mjs` loads the built `main.js` into jsdom with a stubbed `obsidian` module,
points `HOME` at a throwaway folder containing a real Claude Code transcript, and checks that the
plugin registers its view, decodes all 92 furniture sprites and 6 character sheets, mounts the
canvas, discovers the transcript as an agent, and turns an appended `tool_use` line into an
`agentToolStart` event. It is not a substitute for using the thing, but it fails loudly if the
port is broken.

## Credits

All of the interesting work here belongs to other people:

- **[pixel-agents](https://github.com/pablodelucca/pixel-agents)** by
  [Pablo De Lucca](https://github.com/pablodelucca) — the original VS Code extension: the office,
  the characters, the sprites, the editor, the whole look. MIT.
- **[pixel-agents-desktop](https://github.com/Dsantiagomj/pixel-agents-desktop)** by
  [Daniel Munoz](https://github.com/Dsantiagomj) — the Electron port that cut the VS Code
  dependency and replaced manual agent registration with transcript discovery. Every host-side
  module in `src/host/` comes from there. MIT.
- **[Claudian](https://github.com/YishenTu/claudian)** by
  [Yishen Tu](https://github.com/YishenTu) — the reason this port exists.
- The bundled **FS Pixel Sans** font ships in both upstream projects without a separate license
  file, so its original terms could not be verified. It is included here to keep the UI looking
  the way it was designed. If you know its provenance, please open an issue.

This port: Dennis Kolvenbach, written by Claude. MIT — see [LICENSE](LICENSE).
