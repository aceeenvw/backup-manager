# ⊹ BACKUP MANAGER ⊹

A SillyTavern UI extension to selectively **export** your important user data into
a single compressed ZIP. Built by `aceenvw`.

**Export-only by design.** Restoring is a simple **manual** process (see
[How to restore manually](#how-to-restore-manually)). This keeps the extension
small, safe, and predictable — it never writes to or overwrites your data.

It runs as a pure client-side extension and reuses SillyTavern's existing,
CSRF-protected, per-user API endpoints. Backups are built locally with the
bundled `/lib/jszip.min.js` (JSZip v3.10.1). No server plugin is required.

---

## What it does

- Adds a **⊹ BACKUP MANAGER ⊹** panel under Extensions settings.
- Pick categories → **Create backup ZIP** with a self-describing
  `backup-manifest.json` → download.
- **Verify backup**: re-check a ZIP's integrity (manifest + path safety + hashes).
- Never imports, writes, overwrites, renames, or deletes anything.

---

## Supported export categories

| Category | ZIP path | Source endpoint(s) |
|---|---|---|
| Character cards | `characters/<name>.png` | `POST /api/characters/export` |
| Chats (PRIVATE) | `chats/<char-id>/*.jsonl` | `POST /api/characters/chats` + `POST /api/chats/get` |
| Lorebooks / World Info | `worlds/<name>.json` | `POST /api/worldinfo/get` |
| Backgrounds | `backgrounds/<file>` | `POST /api/backgrounds/all` + `GET /backgrounds/<file>` |
| CSS themes | `themes/<name>.json` | `POST /api/settings/get` (themes) |
| Presets (OpenAI only) | `presets/openai/<name>.json` | PresetManager (`openai`) |
| Personas metadata | `personas/personas.json` | `POST /api/settings/get` → `power_user.personas` |
| Persona images | `persona-images/<file>` | `POST /api/avatars/get` + `GET /User Avatars/<file>` |
| Regex scripts | `regexes/regexes.json` | `POST /api/settings/get` → `extension_settings.regex` |
| User images / gallery | `user-images/<folder>/<file>` | `POST /api/images/folders` + `list` |
| Extension list (names + repo links) | `extensions-links.json` | `GET /api/extensions/discover` + each `manifest.json` `homePage` |

Only **OpenAI / chat-completion** presets are exported. Other preset APIs (textgen,
kobold, novel, context, instruct, sysprompt, reasoning) are not exported.
**Chats**, **personas**, **regex**, **user-images**, and **extension-list** are
**off by default** and must be ticked.

> ⚠️ **Privacy:** a backup can contain private characters, chats, persona text,
> and images. Persona metadata holds identity/profile/prompt info; regex can alter
> chat behavior. Progress shows **counts only** — never names or contents.

---

## Backup ZIP layout

```
sillytavern-backup-YYYY-MM-DD-HH-mm.zip
├── backup-manifest.json
├── characters/<name>.png
├── chats/<character-id>/<chat>.jsonl
├── chats/<character-id>/_mapping.json
├── worlds/<name>.json
├── backgrounds/<file>
├── themes/<name>.json
├── presets/openai/<name>.json
├── personas/personas.json
├── persona-images/<file>
├── regexes/regexes.json            (ST-native array; directly importable)
├── regexes/regex-presets.json      (only if you have regex presets; reference)
├── user-images/<folder>/<file>
└── extensions-links.json          (only if extension-list selected; URLs sanitized)
```

All archive paths are **relative**. No absolute paths or local usernames are stored.

---

## How to restore manually

This extension **only exports**. To restore, unzip the backup and put each
category back using SillyTavern's own UI or data folders. For a full one-click
restore of everything, prefer SillyTavern's native
**User Settings → Account → Download Backup / restore** instead.

| Category | How to restore |
|---|---|
| **Characters** (`characters/*.png`) | SillyTavern → Characters panel → **Import Character** → pick the `.png`. |
| **Worlds / Lorebooks** (`worlds/*.json`) | World Info panel → **Import World Info** → pick the `.json`. |
| **CSS themes** (`themes/*.json`) | User Settings → Themes → **Import theme**, or drop the file into your `<user>/themes/` folder and reload. |
| **Presets (OpenAI)** (`presets/openai/*.json`) | Chat Completion settings → preset dropdown → **Import preset** → pick the `.json`. |
| **Backgrounds** (`backgrounds/*`) | Backgrounds panel → **upload**, or drop files into `<user>/backgrounds/`. |
| **Persona images** (`persona-images/*`) | Persona Management → **upload** each image (or drop into `<user>/User Avatars/`). |
| **Personas metadata** (`personas/personas.json`) | Open the JSON; it maps avatar filename → display name plus descriptions. Re-create personas in Persona Management, or merge the entries into `power_user.personas` / `power_user.persona_descriptions` in your `settings.json` while SillyTavern is stopped. |
| **Regex scripts** (`regexes/regexes.json`) | Regex extension → **Import** → pick `regexes.json`. It is a native ST array of scripts, so all are imported at once. (`regex-presets.json`, if present, is reference only — re-create presets in the Regex UI.) |
| **Chats** (`chats/<char-id>/*.jsonl`) | Place each `.jsonl` into that character's chat folder (`<user>/chats/<character>/`). `_mapping.json` records the character id/name. |
| **User images** (`user-images/<folder>/*`) | Drop into `<user>/user/images/<folder>/`. |
| **Extension list** (`extensions-links.json`) | A reference list of installed extensions + repo links. Re-install manually via the listed URLs; nothing is auto-installed. |

> Tip: editing `settings.json` by hand should be done with SillyTavern **stopped**,
> on a copy first. When in doubt, use the native Download Backup for a guaranteed
> full restore.

---

## Verify backup

**Verify backup** re-opens a ZIP you created and checks it is intact and
restorable: the `backup-manifest.json` parses, every listed file is present, and
each file's `sha256` still matches the manifest. It is **read-only** — it writes
nothing. Use it to confirm a backup before relying on it.

---

## Privacy exclusions (never exported)

The following are never collected by any export path — there is no collector that
targets them, so they are never opened, parsed, hashed, or logged:

- `secrets.json`, API keys, tokens, passwords, bearer tokens
- `.env`, `config.yaml`
- cookies / session / cache files
- raw `.git/config` (extension repo URLs are sanitized of any credentials)
- any filename containing `token`, `key`, `secret`, or `password`

There is **no secrets category**. Backups still contain personal content
(characters, chats, personas, images) — keep your ZIPs somewhere safe.

---

## Manifest fields (`backup-manifest.json`)

| Field | Meaning |
|---|---|
| `schemaVersion` | Manifest schema version |
| `extensionVersion` | Extension version that wrote the backup |
| `stVersion` | SillyTavern version if available |
| `registryVersion` | Category registry version |
| `createdISO` | ISO timestamp |
| `selectedCategories` | Categories chosen at export |
| `counts` | Per-folder file counts |
| `totalUncompressedSize` | Sum of file sizes (bytes) |
| `perFile` | `[{ path, size, hash(sha256) }]` (relative paths) |
| `warnings` | Export warnings |
| `extensionLinksSanitized` | Extension names + credential-sanitized URLs |
| `_meta.watermark` | Build/authorship marker (NOT a security signature) |

No secret values, no absolute paths, and no usernames are ever written.

---

## Provenance

Build/authorship marker (not a security feature). In DevTools:

```js
atob(document.querySelector('#bm-root')?.dataset.bmBuild || '')
```

---

## License

Released under the **MIT License** — see [`LICENSE`](./LICENSE). Copyright © 2026
`aceenvw`.

You are free to use, modify, and redistribute it. If you fork or build on this
project, please keep a visible credit to the original author `aceenvw` — this is
a kind request, not a legal condition of the MIT license.
