<div align="center">

# ⊹ ✦ BACKUP MANAGER ✦ ⊹

### *Your SillyTavern data, packed into one selective backup.*

[![Version](https://img.shields.io/badge/version-1.1.0-4a6a8a?style=flat-square)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-2d5a3a?style=flat-square)](LICENSE)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-1.19.0+-3a7a4a?style=flat-square)](https://github.com/SillyTavern/SillyTavern)

Choose categories → download a ZIP → review what was collected.

</div>

## ✦ Highlights

| | |
|---|---|
| **Selective backups** | Cards, solo/group chats, lorebooks, images, themes, presets, and more. |
| **Coverage report** | Collected, partial, failed, empty, and skipped categories in the panel and ZIP. |
| **Integrity checks** | File presence, safe paths, sizes, and SHA-256 hashes. |
| **Remembered choices** | Category selection, size limit, and last download start saved per account. |
| **Mobile-friendly** | Wrapping labels, touch-sized controls, and adjustable backup limits. |
| **English / Russian UI** | Follows SillyTavern's language; other languages use English. |

## ✦ Install

1. In SillyTavern **1.19.0 or newer**, open **Extensions → Install Extension**.
2. Paste `https://github.com/aceeenvw/backup-manager` and install.
3. Reload, then open **⊹ BACKUP MANAGER ⊹** in Extensions settings.

Reload after updating. No server plugin is needed.

---

## ⊹ Create a backup

1. Pick categories, or use **Recommended**. Chats and persona metadata are off by default.
2. Optionally **Check counts**. Solo-chat counts total the chat files across all characters; gallery counts show folders.
3. Click **Create backup ZIP**, then save the browser download.
4. Open **Coverage report** and review warnings. A partial backup includes only the files successfully collected.

The ZIP includes `backup-report.json` and `backup-manifest.json`, with original names
and file mappings for restoration. **Last download started** records the browser
handoff, not confirmation that you saved the file. Choices are stored in your
SillyTavern account settings.

---

## ✦ Included categories

| Category | ZIP location / scope |
|---|---|
| Character cards | `characters/` — PNG cards |
| Solo character chats | `chats/` — raw JSONL and per-character mappings |
| Groups and group chats | `groups/`, `group-chats/` — definitions, referenced chats, relationships |
| Lorebooks / World Info | `worlds/` — JSON |
| Backgrounds and themes | `backgrounds/`, `themes/` |
| Chat Completion presets | `presets/openai/` — stored presets with known sensitive fields removed |
| Persona metadata and images | `personas/personas.json`, `persona-images/` — separate selections |
| Global regex scripts | `regexes/regexes.json`; regex presets saved separately for reference |
| Gallery folder images | `user-images/` — images inside named folders |
| Extension names and links | `extensions-links.json` — declared homepages, versions, enabled state |

Excluded: secrets/config/session files, attachments, vectors, settings snapshots,
extension code/settings, other preset types, orphaned group chats, custom group
avatars, gallery root images/video/audio, and background folder organization.

---

## ⊹ Restore

Extract the ZIP and use SillyTavern's imports or original account data folders.
This extension does not restore archives automatically; its ZIP is not a drop-in
copy of SillyTavern's native account backup. For filesystem restoration, stop
SillyTavern and make a copy of the destination data first.

| Category | How to restore |
|---|---|
| **Cards / lorebooks / themes / presets** | Use **Import Character**, **Import World Info**, **Import theme**, or Chat Completion **Import preset**. Preset connections must be configured again. |
| **Backgrounds** | Upload in the Backgrounds panel, or copy into the account's `backgrounds/` folder. |
| **Personas** | Restore images into `User Avatars/` with their original filenames first, then use Persona Management's native **Restore** on `personas/personas.json`. Metadata restore merges and skips existing entries. |
| **Solo chats** | Restore the character first. Use each `_mapping.json` to copy JSONL files into `chats/<avatar filename without extension>/` with their original names. If card import renamed the avatar, use its new filename's stem. |
| **Groups** | Use `groups/_mapping.json`: copy definitions to `groups/<original group ID>.json` and chats to `group chats/<original chat ID>.jsonl`. Restore member cards with their original avatar filenames, or adjust the definition's member references. |
| **Global regex** | Import `regexes/regexes.json` in the Regex extension. Native import changes script IDs; recreate regex presets in the UI. |
| **Gallery images** | Copy into the account's `user/images/<original folder>/`. |
| **Extension list** | Use the declared homepages as a reference for manual reinstallation. |

Archive filenames may be sanitized or numbered to prevent collisions. The
manifest's file mappings preserve original names. When restoring linked data,
use those original names rather than blindly copying the archive's folder layout.

---

## ✦ Verify a backup

Click **Verify backup** and select a ZIP. It checks supported manifests, safe and
unique paths, declared/actual sizes, missing/extra files, and available SHA-256
hashes. Older schema-1 backups are supported when their paths and manifest are valid.

**Integrity verified** means the files match the manifest; it does not prove
authenticity, completeness, or successful restoration. Missing hashes are reported
as **Unverified**. Use HTTPS or localhost to enable browser SHA-256 support.

---

## ⊹ Large backups / mobile

The collection and verification limit defaults to **256 MiB**, adjustable from
**32 to 2048 MiB**, with a **10,000-file ceiling** including reports. Already-compressed
images are stored without recompression. ZIP creation still runs in memory and
needs more RAM than the collected size; choose smaller category sets on mobile.
Manifests and API metadata responses have a fixed **8 MiB** limit.

Keep the page open while exporting. Cancel aborts requests and prevents download;
compression already underway may finish before the operation unlocks. If a limit
is reached, reduce the selection or raise it only when your device can handle it.

---

## ✦ Privacy

Backups are built in your browser using SillyTavern's bundled ZIP library and
account-scoped APIs. They can contain private conversations, prompts, profiles,
names, and images. Keep them private and inspect custom content before sharing.

Known sensitive fields are removed from preset copies; provider/model choices are
retained. This is not a blanket filter for secrets someone put inside ordinary
text or custom fields.
Extension homepage credentials, query strings, and fragments are removed.
Export does not save, restore, or delete source content; SillyTavern's read APIs
may update metadata caches or create directories. Only this extension's preferences
and download timestamp are saved to account settings.

---

## ⊹ Credits / license

By **aceenvw** · [SillyTavern](https://github.com/SillyTavern/SillyTavern) ·
[JSZip](https://stuk.github.io/jszip/). Released under the [MIT License](LICENSE).
