# Ins eigene GitHub-Repo hochladen

Das Repo ist fertig committed, es fehlt nur noch der Push. Der musste bei dir
laufen, weil die Cloud-Session keine Repos in deinem Account anlegen darf.

## Variante A: mit GitHub CLI (`gh`)

```powershell
cd "$env:USERPROFILE\Downloads\obsidian-pixel-agents"
gh auth login          # nur beim ersten Mal
gh repo create DK-SIVA/obsidian-pixel-agents --public --source . --push
git tag 1.0.0
git push origin 1.0.0  # loest den Release-Workflow aus -> BRAT findet die Version
```

## Variante B: ohne gh

1. Auf github.com ein leeres Repo `obsidian-pixel-agents` anlegen
   (kein README, keine .gitignore, keine Lizenz).
2. Dann:

```powershell
cd "$env:USERPROFILE\Downloads\obsidian-pixel-agents"
git remote add origin https://github.com/DK-SIVA/obsidian-pixel-agents.git
git push -u origin main
git tag 1.0.0
git push origin 1.0.0
```

Der Workflow in `.github/workflows/release.yml` baut beim Tag automatisch und
haengt `main.js`, `manifest.json` und `styles.css` an den Release. Genau die drei
Dateien zieht BRAT.

## Danach in Obsidian

BRAT installieren und aktivieren, dann
`BRAT: Add a beta plugin for testing` -> `DK-SIVA/obsidian-pixel-agents`.

## Ohne GitHub sofort testen

Der Ordner `manual-install\` enthaelt die drei fertigen Dateien. Kopiere sie nach
`<Vault>\.obsidian\plugins\pixel-agents\`, dann in Obsidian unter
Einstellungen -> Community plugins einmal neu laden und "Pixel Agents" aktivieren.
Updates laufen dann aber nicht ueber BRAT.
