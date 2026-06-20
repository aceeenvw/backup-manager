// ⊹ BACKUP MANAGER ⊹ — aceenvw
//
// Export-only SillyTavern extension. Selectively packs your data into one ZIP.
// Never writes to user data; restore is manual (see README). "Verify backup" is
// a read-only integrity check. Pure client-side; uses ST's bundled JSZip only.

const MODULE_NAME = 'backup_manager';
const MODULE_VERSION = '1.0.1';
const SCHEMA_VERSION = 1;
const REGISTRY_VERSION = 3;

// Only OpenAI / chat-completion presets are exported. Other preset APIs
// (textgen, kobold, novel, context, instruct, etc.) are intentionally skipped.
const PRESET_API_IDS = ['openai'];

const ctx = SillyTavern.getContext();
const { extensionSettings, saveSettingsDebounced } = ctx;

// ─── Build marker ───
// Authorship/build stamp only — NOT a security signature. Never used for trust,
// validation, or tamper detection. Written to the panel root as [data-bm-build];
// the stylesheet keys the panel chrome off it.
function buildMarker() {
    const h = (MODULE_NAME + MODULE_VERSION).split('').reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(36);
    return btoa(JSON.stringify({ a: 'aceenvw', v: MODULE_VERSION, h }));
}

// ─── Logging ───
// All log/UI output is passed through redact() so secret-like strings (API keys,
// bearer tokens, long tokens, URL credentials) never reach the console or UI.
const SECRET_RX = /(sk-[A-Za-z0-9]{8,})|(bearer\s+[A-Za-z0-9._-]{8,})|([A-Za-z0-9._-]{40,})|(https?:\/\/[^/\s]*:[^/@\s]*@)/gi;
function redact(s) {
    return String(s ?? '').replace(SECRET_RX, '[REDACTED]');
}
function log(...a) { console.log('[bm:backup_manager]', ...a.map(x => typeof x === 'string' ? redact(x) : x)); }
function warn(...a) { console.warn('[bm:backup_manager]', ...a.map(x => typeof x === 'string' ? redact(x) : x)); }

// ─── Request headers ───
// Reuse ST's helper (CSRF token + cookie). User isolation is enforced by the
// server from the session; we never pass a user handle.
function headers() {
    if (typeof window.getRequestHeaders === 'function') return window.getRequestHeaders();
    if (typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    return { 'Content-Type': 'application/json' };
}

// ─── JSZip loader (LOCAL ONLY — no CDN fallback) ───
// Loads SillyTavern's bundled JSZip. If it is missing, export stops with an
// error; we never fetch a remote copy.
let _zipReady = false;
async function ensureZip() {
    if (_zipReady && window.JSZip) return true;
    if (window.JSZip) { _zipReady = true; return true; }
    const ok = await new Promise(resolve => {
        const s = document.createElement('script');
        s.src = '/lib/jszip.min.js';
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
    });
    if (ok && window.JSZip) { _zipReady = true; return true; }
    return false;
}

// ─── Utility helpers ───

// Trigger a browser download of a Blob.
function downloadBlob(blob, name) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

// Timestamp for the backup filename: YYYY-MM-DD-HH-mm.
function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

// Make a string safe as a file/folder name: strip reserved chars and path
// traversal, escape Windows reserved names, cap length. Preserves Unicode.
const _WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
function sanitize(name) {
    let s = String(name ?? '');
    s = s.replace(/[\/\\?%*:|"<>\x00-\x1F]/g, '_');
    s = s.replace(/^\.+/, '');
    s = s.replace(/[. ]+$/, '');
    if (s.length > 120) s = s.slice(0, 120);
    if (_WIN_RESERVED.test(s)) s = '_' + s;
    if (!s || /^_+$/.test(s)) s = 'unnamed';
    return s;
}

// SHA-256 hex digest of a Blob/ArrayBuffer/string (used for integrity only).
async function sha256(data) {
    let buf;
    if (data instanceof Blob) buf = await data.arrayBuffer();
    else if (typeof data === 'string') buf = new TextEncoder().encode(data);
    else buf = data;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Strip credentials and query/userinfo from a URL before storing it (tokens
// often hide in the query string).
function sanitizeUrl(url) {
    try {
        const u = new URL(String(url));
        u.username = '';
        u.password = '';
        u.search = '';
        return u.origin + u.pathname;
    } catch {
        // Not a parseable URL: redact secrets and drop any inline credentials.
        return redact(String(url || '')).replace(/\/\/[^/@]*@/, '//');
    }
}

// ─── Category registry ───
// One row per exportable category. Fields:
//   kind          'settings' = read from the settings blob (personas, regex);
//                 'list' = names/links only (extensions); else a file/API category.
//   risk          low | med | high — shown as a coloured pill in the UI.
//   defaultEnabled whether it is ticked by default.
//   stage2Export  true once a working export collector (exportFn) is wired.
//   experimental  off by default and skipped by "Recommended".
const REGISTRY = [
    { id: 'characters', label: 'Character cards', zipFolder: 'characters', risk: 'high', defaultEnabled: true, warning: 'May contain private notes.', list: listCharacters, stage2Export: true, exportFn: exportCharacters },
    { id: 'chats', label: 'Chats (private!)', zipFolder: 'chats', risk: 'high', defaultEnabled: false, warning: 'PRIVATE: chats may contain private roleplay, persona data, names, prompts, and sensitive content.', list: listChats, stage2Export: true, exportFn: exportChats },
    { id: 'worlds', label: 'Lorebooks / World Info', zipFolder: 'worlds', risk: 'med', defaultEnabled: true, warning: '', list: listWorlds, stage2Export: true, exportFn: exportWorlds },
    { id: 'backgrounds', label: 'Backgrounds', zipFolder: 'backgrounds', risk: 'low', defaultEnabled: true, warning: '', list: listBackgrounds, stage2Export: true, exportFn: exportBackgrounds },
    { id: 'themes', label: 'CSS themes', zipFolder: 'themes', risk: 'low', defaultEnabled: true, warning: '', list: listThemes, stage2Export: true, exportFn: exportThemes },
    { id: 'presets', label: 'Presets (OpenAI)', zipFolder: 'presets', risk: 'med', defaultEnabled: true, warning: '', list: listPresets, stage2Export: true, exportFn: exportPresets },
    { id: 'personas', label: 'Personas metadata', zipFolder: 'personas', kind: 'settings', risk: 'high', defaultEnabled: false, warning: 'PRIVATE: persona metadata can contain identity/profile/prompt information.', list: listPersonas, stage2Export: true, exportFn: exportPersonas },
    { id: 'persona-images', label: 'Persona images', zipFolder: 'persona-images', risk: 'med', defaultEnabled: true, warning: '', list: listPersonaImages, stage2Export: true, exportFn: exportPersonaImages },
    { id: 'user-images', label: 'User images / gallery', zipFolder: 'user-images', risk: 'med', defaultEnabled: false, warning: '', list: listUserImages, stage2Export: true, exportFn: exportUserImages },
    { id: 'regex', label: 'Regex scripts', zipFolder: 'regexes', kind: 'settings', risk: 'med', defaultEnabled: false, warning: 'Regex scripts can alter chat display/behavior; broken regex can affect many chats.', list: listRegex, stage2Export: true, exportFn: exportRegex },
    { id: 'extension-list', label: 'Extension list (names + repo links if declared)', zipFolder: '', kind: 'list', risk: 'med', defaultEnabled: false, warning: 'Repo links come from each extension manifest homePage (when declared). No auto-install. No .git access.', list: listExtensions, stage2Export: true, exportFn: exportExtensionList },
];

// Categories that are never collected (privacy / safety / no safe endpoint).
// This list is informational: it documents what the extension intentionally
// does NOT export. There are no collectors for these — secrets/.env/config/
// cookies are never targeted by any export path — so nothing here is ever read,
// parsed, hashed, or written. It is shown in the UI so users know the scope.
const EXCLUDED = [
    { id: 'secrets', reason: 'NEVER. API keys / secrets.json are never collected.' },
    { id: 'env-config', reason: '.env / config.yaml are never collected.' },
    { id: 'cookies-session', reason: 'cookies / session / cache are never collected.' },
    { id: 'vectors', reason: 'Large rebuildable index; advanced only.' },
    { id: 'thumbnails', reason: 'Regenerated automatically; advanced only.' },
    { id: 'settings-snapshots', reason: 'Use native snapshot API; advanced only.' },
    { id: 'data-bank', reason: 'User files/attachments; advanced only.' },
    { id: 'extension-folders', reason: 'Risky code; advanced only, off by default.' },
];

// ─── Counts (scan only) ───
// list* helpers report availability and item counts for the UI. They never read
// file contents and never write. Each returns { ok, count, note, verified }.

async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
}

// Return the parsed settings object (holds power_user, extension_settings,
// themes). /api/settings/get may return `settings` as a JSON string or as
// already-parsed fields; handle both.
async function fetchSettings() {
    const d = await postJson('/api/settings/get', {});
    const parsed = typeof d?.settings === 'string' ? JSON.parse(d.settings) : (d?.settings || d);
    return parsed || {};
}

// power_user object, with a context fallback.
async function fetchPowerUser() {
    try { const s = await fetchSettings(); if (s && typeof s.power_user === 'object') return s.power_user; if (s && typeof s.powerUserSettings === 'object') return s.powerUserSettings; } catch { /* fall through */ }
    return ctx.powerUserSettings || ctx.power_user || {};
}

// extension_settings object, with a context fallback.
async function fetchExtensionSettings() {
    try { const s = await fetchSettings(); if (s && typeof s.extension_settings === 'object') return s.extension_settings; } catch { /* fall through */ }
    return ctx.extensionSettings || {};
}


async function listCharacters() {
    const chars = ctx.characters || [];
    return { ok: true, count: chars.length, verified: 'context.characters', note: '/api/characters/all (list), /export, /import' };
}

async function listChats() {
    // Per-character chat listing is expensive, so the count shows the number of
    // characters (a proxy) rather than the total chat files.
    const chars = (ctx.characters || []).filter(c => c.avatar);
    return { ok: true, count: chars.length, verified: 'context.characters (proxy)', note: '/api/characters/chats per char; /api/chats/get|save' };
}

async function listWorlds() {
    try {
        const d = await postJson('/api/settings/get', {});
        const names = d?.world_names || [];
        return { ok: true, count: names.length, verified: '/api/settings/get -> world_names', note: '/api/worldinfo/get|edit|import' };
    } catch (e) { warn('listWorlds', e.message); return { ok: false, count: null, verified: 'failed', note: String(e.message) }; }
}

async function listBackgrounds() {
    try {
        const d = await postJson('/api/backgrounds/all', {});
        const imgs = Array.isArray(d) ? d : (d?.images || []);
        return { ok: true, count: imgs.length, verified: '/api/backgrounds/all', note: '/upload, /delete, /rename' };
    } catch (e) { warn('listBackgrounds', e.message); return { ok: false, count: null, verified: 'failed', note: String(e.message) }; }
}

async function listThemes() {
    try {
        // themes are a top-level field of /api/settings/get (a sibling of the
        // `settings` string), not inside power_user. Match exportThemes.
        const d = await postJson('/api/settings/get', {});
        const parsed = typeof d?.settings === 'string' ? JSON.parse(d.settings) : (d?.settings || d);
        const themes = Array.isArray(d?.themes) ? d.themes
            : Array.isArray(parsed?.themes) ? parsed.themes
                : [];
        return { ok: true, count: themes.length, verified: '/api/settings/get -> themes', note: 'export via /api/settings/get' };
    } catch (e) { warn('listThemes', e.message); return { ok: false, count: null, verified: 'failed', note: String(e.message) }; }
}

async function listPresets() {
    // Count presets the same way exportPresets enumerates them, so the count
    // always matches what gets exported.
    try {
        if (typeof ctx.getPresetManager !== 'function') {
            return { ok: false, count: null, verified: 'missing', note: 'PresetManager unavailable' };
        }
        let total = 0;
        for (const apiId of PRESET_API_IDS) {
            let mgr; try { mgr = ctx.getPresetManager(apiId); } catch { continue; }
            if (!mgr || typeof mgr.getAllPresets !== 'function') continue;
            let names = []; try { names = mgr.getAllPresets() || []; } catch { continue; }
            total += names.length;
        }
        return { ok: true, count: total, verified: 'PresetManager.getAllPresets', note: 'OpenAI presets' };
    } catch (e) { warn('listPresets', e.message); return { ok: false, count: null, verified: 'failed', note: String(e.message) }; }
}

async function listPersonas() {
    try {
        const pu = await fetchPowerUser();
        const personas = pu?.personas && typeof pu.personas === 'object' ? pu.personas : {};
        return { ok: true, count: Object.keys(personas).length, verified: 'settings.power_user.personas', note: 'metadata export (no image bytes)' };
    } catch (e) { warn('listPersonas', e.message); return { ok: false, count: null, verified: 'failed', note: String(e.message) }; }
}

async function listPersonaImages() {
    try {
        const d = await postJson('/api/avatars/get', {});
        const arr = Array.isArray(d) ? d : [];
        return { ok: true, count: arr.length, verified: '/api/avatars/get', note: '/api/avatars/upload|delete' };
    } catch (e) { warn('listPersonaImages', e.message); return { ok: false, count: null, verified: 'failed', note: String(e.message) }; }
}

async function listUserImages() {
    try {
        const folders = await postJson('/api/images/folders', {});
        const c = Array.isArray(folders) ? folders.length : (folders ? Object.keys(folders).length : 0);
        return { ok: true, count: c, verified: '/api/images/folders', note: '/api/images/list|upload|delete (per folder)' };
    } catch (e) { warn('listUserImages', e.message); return { ok: false, count: null, verified: 'failed', note: String(e.message) }; }
}

async function listRegex() {
    try {
        const es = await fetchExtensionSettings();
        const arr = Array.isArray(es?.regex) ? es.regex : [];
        return { ok: true, count: arr.length, verified: 'settings.extension_settings.regex', note: 'ST-native array; directly importable' };
    } catch (e) { warn('listRegex', e.message); return { ok: false, count: null, verified: 'failed', note: String(e.message) }; }
}

async function listExtensions() {
    try {
        const r = await fetch('/api/extensions/discover', { headers: headers() });
        if (!r.ok) throw new Error(`/api/extensions/discover -> ${r.status}`);
        const d = await r.json();
        const arr = Array.isArray(d) ? d : [];
        return { ok: true, count: arr.length, verified: '/api/extensions/discover', note: 'list/links only; URLs sanitized; no auto-install' };
    } catch (e) { warn('listExtensions', e.message); return { ok: false, count: null, verified: 'failed', note: String(e.message) }; }
}

// ─── Export collectors ───
// Read-only collectors that gather files for the ZIP. Each returns
// { files: [{ path, data }], warnings: [] }, where path is relative inside the
// ZIP and data is a Blob or string. All honour the _abort cancel flag.

let _abort = false;

async function postBlob(url, body) {
    const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.blob();
}

async function exportCharacters(onItem) {
    const chars = (ctx.characters || []).filter(c => c.avatar);
    const files = [], warnings = [], used = new Set();
    for (let i = 0; i < chars.length; i++) {
        if (_abort) break;
        const c = chars[i];
        onItem && onItem(`characters: ${i + 1}/${chars.length}`);
        try {
            const blob = await postBlob('/api/characters/export', { avatar_url: c.avatar, format: 'png' });
            let base = sanitize(c.name || 'character');
            let name = `${base}.png`, n = 2;
            while (used.has(name.toLowerCase())) name = `${base} (${n++}).png`;
            used.add(name.toLowerCase());
            files.push({ path: `characters/${name}`, data: blob });
        } catch (e) { warnings.push(`character ${sanitize(c.name || '?')}: ${redact(e.message)}`); }
    }
    return { files, warnings };
}

async function exportWorlds(onItem) {
    const files = [], warnings = [], used = new Set();
    let names = [];
    try { const d = await postJson('/api/settings/get', {}); names = d?.world_names || []; }
    catch (e) { return { files, warnings: [`worlds list: ${redact(e.message)}`] }; }
    for (let i = 0; i < names.length; i++) {
        if (_abort) break;
        onItem && onItem(`worlds: ${i + 1}/${names.length}`);
        try {
            const data = await postJson('/api/worldinfo/get', { name: names[i] });
            let base = sanitize(names[i]);
            let name = `${base}.json`, n = 2;
            while (used.has(name.toLowerCase())) name = `${base} (${n++}).json`;
            used.add(name.toLowerCase());
            files.push({ path: `worlds/${name}`, data: JSON.stringify(data) });
        } catch (e) { warnings.push(`world ${sanitize(names[i])}: ${redact(e.message)}`); }
    }
    return { files, warnings };
}

async function exportBackgrounds(onItem) {
    const files = [], warnings = [], used = new Set();
    let imgs = [];
    try { const d = await postJson('/api/backgrounds/all', {}); imgs = Array.isArray(d) ? d : (d?.images || []); }
    catch (e) { return { files, warnings: [`backgrounds list: ${redact(e.message)}`] }; }
    for (let i = 0; i < imgs.length; i++) {
        if (_abort) break;
        const bg = typeof imgs[i] === 'string' ? imgs[i] : (imgs[i]?.filename || imgs[i]?.name);
        if (!bg) continue;
        onItem && onItem(`backgrounds: ${i + 1}/${imgs.length}`);
        try {
            const r = await fetch(`/backgrounds/${encodeURIComponent(bg)}`, { headers: headers() });
            if (!r.ok) throw new Error(`fetch -> ${r.status}`);
            const blob = await r.blob();
            let name = sanitize(bg), n = 2, dot = name.lastIndexOf('.');
            while (used.has(name.toLowerCase())) { name = dot > 0 ? `${name.slice(0, dot)} (${n++})${name.slice(dot)}` : `${name} (${n++})`; }
            used.add(name.toLowerCase());
            files.push({ path: `backgrounds/${name}`, data: blob });
        } catch (e) { warnings.push(`background ${sanitize(bg)}: ${redact(e.message)}`); }
    }
    return { files, warnings };
}

async function exportThemes(onItem) {
    // Themes live in the settings blob; export each as its own JSON file.
    const files = [], warnings = [], used = new Set();
    let themes = [];
    try {
        const d = await postJson('/api/settings/get', {});
        const parsed = typeof d?.settings === 'string' ? JSON.parse(d.settings) : (d?.settings || d);
        themes = parsed?.themes || d?.themes || [];
    } catch (e) { return { files, warnings: [`themes: ${redact(e.message)}`] }; }
    for (let i = 0; i < themes.length; i++) {
        if (_abort) break;
        onItem && onItem(`themes: ${i + 1}/${themes.length}`);
        const t = themes[i];
        let base = sanitize(t?.name || `theme-${i}`);
        let name = `${base}.json`, n = 2;
        while (used.has(name.toLowerCase())) name = `${base} (${n++}).json`;
        used.add(name.toLowerCase());
        files.push({ path: `themes/${name}`, data: JSON.stringify(t) });
    }
    return { files, warnings };
}

// Persona metadata only (no image bytes — those are in the persona-images
// category). Writes one personas/personas.json keyed by avatar filename so a
// manual restore can map each entry back.
async function exportPersonas(onItem) {
    const files = [], warnings = [];
    let pu;
    try { pu = await fetchPowerUser(); }
    catch (e) { return { files, warnings: [`personas: ${redact(e.message)}`] }; }

    const personas = (pu?.personas && typeof pu.personas === 'object') ? pu.personas : {};
    const descriptions = (pu?.persona_descriptions && typeof pu.persona_descriptions === 'object') ? pu.persona_descriptions : {};
    const keys = Object.keys(personas);
    if (!keys.length) { warnings.push('personas: none found.'); return { files, warnings }; }

    onItem && onItem(`personas: ${keys.length} item(s)`);
    // Self-describing bundle. `personas` maps avatar filename -> display name;
    // `persona_descriptions` maps avatar filename -> description/position/etc.
    const bundle = {
        kind: 'personas-metadata',
        schema: 1,
        count: keys.length,
        defaultPersona: pu?.default_persona ?? null,
        personas,
        persona_descriptions: descriptions,
    };
    files.push({ path: 'personas/personas.json', data: JSON.stringify(bundle, null, 2) });
    return { files, warnings };
}

// Regex scripts from extension_settings.regex. Written in ST's native format —
// a bare array of script objects — so regexes.json imports directly via the
// Regex extension. Any regex presets are saved alongside for reference only
// (ST's regex file import does not consume them).
async function exportRegex(onItem) {
    const files = [], warnings = [];
    let es;
    try { es = await fetchExtensionSettings(); }
    catch (e) { return { files, warnings: [`regexes: ${redact(e.message)}`] }; }

    const regex = Array.isArray(es?.regex) ? es.regex : [];
    const presets = Array.isArray(es?.regex_presets) ? es.regex_presets : [];
    if (!regex.length && !presets.length) { warnings.push('regexes: none found.'); return { files, warnings }; }

    onItem && onItem(`regexes: ${regex.length} script(s)`);
    files.push({ path: 'regexes/regexes.json', data: JSON.stringify(regex, null, 2) });
    if (presets.length) {
        files.push({ path: 'regexes/regex-presets.json', data: JSON.stringify(presets, null, 2) });
    }
    return { files, warnings };
}

// One JSON file per preset, read through PresetManager (OpenAI only).
async function exportPresets(onItem) {
    const files = [], warnings = [];
    if (typeof ctx.getPresetManager !== 'function') return { files, warnings: ['presets: PresetManager unavailable'] };
    for (const apiId of PRESET_API_IDS) {
        if (_abort) break;
        let mgr;
        try { mgr = ctx.getPresetManager(apiId); } catch { continue; }
        if (!mgr || typeof mgr.getAllPresets !== 'function') continue;
        let names = [];
        try { names = mgr.getAllPresets() || []; } catch { continue; }
        const used = new Set();
        for (const nm of names) {
            if (_abort) break;
            try {
                const data = typeof mgr.getCompletionPresetByName === 'function'
                    ? mgr.getCompletionPresetByName(nm)
                    : (typeof mgr.getPresetByName === 'function' ? mgr.getPresetByName(nm) : null);
                if (data == null) continue;
                let base = sanitize(nm);
                let fname = `${base}.json`, n = 2;
                while (used.has(fname.toLowerCase())) fname = `${base} (${n++}).json`;
                used.add(fname.toLowerCase());
                files.push({ path: `presets/${sanitize(apiId)}/${fname}`, data: JSON.stringify(data) });
            } catch (e) { warnings.push(`preset ${sanitize(apiId)}/${sanitize(nm)}: ${redact(e.message)}`); }
        }
        onItem && onItem(`presets: ${apiId}`);
    }
    return { files, warnings };
}

async function exportPersonaImages(onItem) {
    const files = [], warnings = [], used = new Set();
    let avatars = [];
    try { const d = await postJson('/api/avatars/get', {}); avatars = Array.isArray(d) ? d : []; }
    catch (e) { return { files, warnings: [`persona-images list: ${redact(e.message)}`] }; }
    for (let i = 0; i < avatars.length; i++) {
        if (_abort) break;
        const av = avatars[i];
        onItem && onItem(`persona-images: ${i + 1}/${avatars.length}`);
        try {
            const r = await fetch(`/User Avatars/${encodeURIComponent(av)}`, { headers: headers() });
            if (!r.ok) throw new Error(`fetch -> ${r.status}`);
            const blob = await r.blob();
            let name = sanitize(av);
            if (used.has(name.toLowerCase())) name = `${i}-${name}`;
            used.add(name.toLowerCase());
            files.push({ path: `persona-images/${name}`, data: blob });
        } catch (e) { warnings.push(`persona-image ${sanitize(av)}: ${redact(e.message)}`); }
    }
    return { files, warnings };
}

async function exportUserImages(onItem) {
    const files = [], warnings = [];
    let folders = [];
    try {
        const d = await postJson('/api/images/folders', {});
        folders = Array.isArray(d) ? d : (d ? Object.keys(d) : []);
    } catch (e) { return { files, warnings: [`user-images folders: ${redact(e.message)}`] }; }
    for (const folder of folders) {
        if (_abort) break;
        let listing = [];
        try { listing = await postJson('/api/images/list', { folder }); } catch (e) { warnings.push(`user-images ${sanitize(folder)}: ${redact(e.message)}`); continue; }
        const arr = Array.isArray(listing) ? listing : (listing?.images || []);
        const used = new Set();
        for (const item of arr) {
            if (_abort) break;
            const fn = typeof item === 'string' ? item : (item?.path || item?.name);
            if (!fn) continue;
            onItem && onItem(`user-images: ${sanitize(folder)}`);
            try {
                const rel = fn.includes('/') ? fn : `user/images/${folder}/${fn}`;
                const r = await fetch(`/${rel.split('/').map(encodeURIComponent).join('/')}`, { headers: headers() });
                if (!r.ok) throw new Error(`fetch -> ${r.status}`);
                const blob = await r.blob();
                const safeFolder = sanitize(folder), safeName = sanitize(fn.split('/').pop());
                let name = `${safeFolder}/${safeName}`;
                if (used.has(name.toLowerCase())) name = `${safeFolder}/${Date.now()}-${safeName}`;
                used.add(name.toLowerCase());
                files.push({ path: `user-images/${name}`, data: blob });
            } catch (e) { warnings.push(`user-image ${sanitize(String(fn))}: ${redact(e.message)}`); }
        }
    }
    return { files, warnings };
}

// Return a credential-stripped http(s) URL, or null if it is missing/invalid.
function safeHttpUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
        const u = new URL(raw.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        u.username = ''; u.password = ''; u.search = ''; u.hash = '';
        return u.origin + u.pathname.replace(/\/+$/, '');
    } catch { return null; }
}

// Extension names plus repo URLs taken from each extension's own manifest.json
// `homePage` (no .git access, no invented URLs). Extensions without a declared
// homePage get repoUrl: null. Output goes to extensions-links.json at ZIP root.
async function exportExtensionList(onItem) {
    const warnings = [];
    let discovered = [];
    try {
        const r = await fetch('/api/extensions/discover', { headers: headers() });
        if (r.ok) discovered = await r.json();
    } catch (e) { warnings.push(`extension-list: ${redact(e.message)}`); }

    const names = (Array.isArray(discovered) ? discovered : []).map(x => ({
        name: typeof x === 'string' ? x : (x?.name || ''),
        type: (x && x.type) || 'unknown',
    })).filter(x => x.name);

    const list = [];
    let withUrl = 0;
    for (let i = 0; i < names.length; i++) {
        if (_abort) break;
        const entry = names[i];
        onItem && onItem(`extensions: ${i + 1}/${names.length}`);
        let homePage = null;
        try {
            const mr = await fetch(`/scripts/extensions/${encodeURIComponent(entry.name)}/manifest.json`, { headers: headers() });
            if (mr.ok) {
                const mj = await mr.json();
                homePage = safeHttpUrl(mj?.homePage);
            }
        } catch { /* manifest unreadable: leave repoUrl null */ }
        if (homePage) withUrl++;
        list.push({ name: sanitize(entry.name), type: entry.type, repoUrl: homePage });
    }

    const note = withUrl > 0
        ? 'Repository links from extension manifest homePage. No auto-install. URLs sanitized.'
        : 'No repository URLs were declared by installed extensions (names only).';
    return {
        files: [{ path: 'extensions-links.json', data: JSON.stringify({ note, extensions: list }, null, 2) }],
        warnings,
        links: list,
    };
}

// Pull a chat file name out of a /api/characters/chats entry, tolerating the
// different shapes (string or object) returned across ST versions.
function extractChatFileName(info) {
    if (typeof info === 'string') return info;
    if (!info || typeof info !== 'object') return null;
    if (info.file_name) return info.file_name;
    if (info.fileName) return info.fileName;
    const keys = Object.keys(info);
    for (const k of keys) {
        if (k.endsWith('.jsonl') || /^\d{4}/.test(k) || k.includes('@')) return k;
    }
    return keys.length ? keys[0] : null;
}

// Export chats: for each character, fetch its chat list, then each chat file.
// Progress reports counts only — never chat names or content. A per-character
// _mapping.json records the character id/name for a manual restore.
async function exportChats(onItem) {
    const chars = (ctx.characters || []).filter(c => c.avatar);
    const files = [], warnings = [];
    let charsWithChats = 0, totalChats = 0;

    for (let i = 0; i < chars.length; i++) {
        if (_abort) break;
        const c = chars[i];
        onItem && onItem(`chats: character ${i + 1}/${chars.length}`);

        let list = null;
        try {
            const d = await postJson('/api/characters/chats', { avatar_url: c.avatar, simple: true });
            list = Array.isArray(d) ? d : (d && typeof d === 'object' ? Object.values(d) : null);
        } catch (e) { warnings.push(`chats(list): ${redact(e.message)}`); continue; }
        if (!list || !list.length) continue;

        const safeId = sanitize(c.avatar.replace(/\.[^.]+$/, ''));   // avatar filename is the ST character id
        const used = new Set();
        let savedForChar = 0;

        for (let j = 0; j < list.length; j++) {
            if (_abort) break;
            const fn = extractChatFileName(list[j]);
            if (!fn) continue;
            const cleanName = String(fn).replace(/\.jsonl$/i, '');
            onItem && onItem(`chats: ${i + 1}/${chars.length} — file ${j + 1}/${list.length}`);
            try {
                const data = await postJson('/api/chats/get', { ch_name: c.name, file_name: cleanName, avatar_url: c.avatar });
                if (!Array.isArray(data) || !data.length) continue;
                const content = data.map(m => JSON.stringify(m)).join('\n');
                let outName = sanitize(cleanName) + '.jsonl', n = 2;
                while (used.has(outName.toLowerCase())) outName = `${sanitize(cleanName)} (${n++}).jsonl`;
                used.add(outName.toLowerCase());
                files.push({ path: `chats/${safeId}/${outName}`, data: content });
                savedForChar++; totalChats++;
            } catch (e) { warnings.push(`chats(get): ${redact(e.message)}`); }
            await new Promise(r => setTimeout(r, 60));
        }

        if (savedForChar > 0) {
            charsWithChats++;
            // Restore-mapping metadata (no chat content).
            const mapping = { kind: 'character-chats', characterId: c.avatar, characterName: c.name || null, chatCount: savedForChar };
            files.push({ path: `chats/${safeId}/_mapping.json`, data: JSON.stringify(mapping, null, 2) });
        }
    }
    if (totalChats === 0) warnings.push('chats: no chats found/exported.');
    return { files, warnings };
}
// ─── Manifest builder ───
// Builds backup-manifest.json: per-file path/size/sha256, counts, and metadata.
// Paths are always relative — never absolute paths, usernames, or secrets.
async function buildManifest(selectedIds, fileEntries, allWarnings, links) {
    const counts = {};
    const perFile = [];
    let totalUncompressedSize = 0;
    for (const f of fileEntries) {
        const folder = f.path.split('/')[0];
        counts[folder] = (counts[folder] || 0) + 1;
        let size = 0;
        if (f.data instanceof Blob) size = f.data.size;
        else if (typeof f.data === 'string') size = new TextEncoder().encode(f.data).length;
        totalUncompressedSize += size;
        let hash = null;
        try { hash = await sha256(f.data); } catch { hash = null; }
        perFile.push({ path: f.path, size, hash });
    }
    const wmH = (MODULE_NAME + MODULE_VERSION).split('').reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(36);
    return {
        schemaVersion: SCHEMA_VERSION,
        extensionVersion: MODULE_VERSION,
        stVersion: (ctx.version || ctx.VERSION || null),
        registryVersion: REGISTRY_VERSION,
        createdISO: new Date().toISOString(),
        selectedCategories: selectedIds,
        counts,
        totalUncompressedSize,
        perFile,
        warnings: allWarnings,
        unsupported: REGISTRY.filter(c => !c.stage2Export).map(c => c.id),
        extensionLinksSanitized: links || [],
        _meta: { watermark: btoa(JSON.stringify({ a: 'aceenvw', v: MODULE_VERSION, h: wmH })) },
    };
}

// ─── Export engine ───
// Runs the selected collectors, builds the manifest, packs the ZIP, downloads it,
// and reports progress/results through the ui controller.
async function runExport(selectedIds, ui) {
    _abort = false;
    if (!(await ensureZip())) {
        ui.error('Local JSZip (/lib/jszip.min.js) not available. Export stopped.');
        return;
    }
    const cats = REGISTRY.filter(c => selectedIds.includes(c.id) && c.stage2Export && typeof c.exportFn === 'function');
    if (!cats.length) { ui.error('No exportable categories selected.'); return; }

    ui.lock();
    const allFiles = [], allWarnings = [];
    let links = [];

    for (let i = 0; i < cats.length; i++) {
        if (_abort) break;
        const cat = cats[i];
        ui.status(`Collecting ${cat.label}…`);
        ui.progress(Math.round((i / cats.length) * 60));
        try {
            const res = await cat.exportFn(msg => ui.status(msg));
            (res.files || []).forEach(f => allFiles.push(f));
            (res.warnings || []).forEach(w => allWarnings.push(w));
            if (res.links) links = res.links;
        } catch (e) { allWarnings.push(`${cat.id}: ${redact(e.message)}`); }
    }

    if (_abort) { ui.unlock(); ui.warn('Export cancelled before writing.'); return; }
    if (!allFiles.length) { ui.unlock(); ui.error('Nothing collected to export.'); return; }

    ui.status('Building manifest…');
    ui.progress(65);
    const manifest = await buildManifest(selectedIds, allFiles, allWarnings, links);

    ui.status('Packing ZIP…');
    const zip = new JSZip();
    zip.file('backup-manifest.json', JSON.stringify(manifest, null, 2));
    for (const f of allFiles) zip.file(f.path, f.data);

    const blob = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
        m => ui.progress(65 + Math.round(m.percent * 0.35)),
    );
    downloadBlob(blob, `sillytavern-backup-${stamp()}.zip`);
    ui.unlock();
    const sizeMB = (manifest.totalUncompressedSize / 1048576);
    const sizeStr = sizeMB >= 1 ? `${sizeMB.toFixed(1)}MB` : `${Math.ceil(manifest.totalUncompressedSize / 1024)}KB`;
    const catSummary = Object.entries(manifest.counts || {}).map(([k, n]) => `${k} ${n}`).join(', ');
    ui.success(`Backup created: ${allFiles.length} files, ${sizeStr}${allWarnings.length ? `, ${allWarnings.length} warning(s)` : ''}.`);
    if (catSummary) ui.status(`Backup: ${redact(catSummary)} | ${sizeStr}${allWarnings.length ? ` | ${allWarnings.length} warning(s)` : ''}`);
    log(`export done: files=${allFiles.length} warnings=${allWarnings.length}`);
}

// ─── UI controller ───
// Bridges the export engine to the DOM (buttons, status line, progress bar). All
// text is redacted before display.
const exportUi = {
    lock() { $('#bm-export-go,#bm-verify-btn,#bm-refresh-counts').prop('disabled', true); $('#bm-cancel-btn').show(); $('#bm-progress').addClass('active'); },
    unlock() { $('#bm-export-go,#bm-verify-btn,#bm-refresh-counts').prop('disabled', false); $('#bm-cancel-btn').hide(); $('#bm-progress').removeClass('active'); this.progress(0); },
    status(t) { $('#bm-status').text(redact(t)); },
    progress(p) { $('#bm-bar-fill').css('width', `${p}%`); },
    success(m) { (window.toastr || console).success?.(redact(m)) ?? log(m); this.status(redact(m)); },
    warn(m) { (window.toastr || console).warning?.(redact(m)) ?? warn(m); this.status(redact(m)); },
    error(m) { (window.toastr || console).error?.(redact(m)) ?? warn(m); this.status(redact(m)); },
};

function getSelectedExportIds() {
    return REGISTRY.filter(c => $(`#bm-cat-${c.id}`).is(':checked') && c.stage2Export).map(c => c.id);
}

// ─── UI build ───

// Update the item count next to each category using the list* helpers.
async function refreshCounts() {
    for (const cat of REGISTRY) {
        const $c = $(`#bm-count-${cat.id}`);
        if (!$c.length) continue;
        $c.text('…');
        try { const r = await cat.list(); $c.text(r.count == null ? '?' : r.count); }
        catch { $c.text('?'); }
    }
}

function buildExportTab() {
    const $tab = $('<div id="bm-tab-export" class="bm-tab">');
    $tab.append('<p class="bm-intro">Pick what to back up, then download one ZIP. Restoring is manual — see the README for where each file goes.</p>');
    $tab.append('<div class="bm-warning"><i class="fa-solid fa-triangle-exclamation"></i> Backups can contain private chats, personas, character data, images, and extension metadata. Keep them safe.</div>');

    const $bar = $('<div class="bm-selbar">');
    $bar.append('<button class="bm-btn" id="bm-sel-all"><i class="fa-solid fa-check-double"></i> All</button>');
    $bar.append('<button class="bm-btn" id="bm-sel-none"><i class="fa-regular fa-square"></i> None</button>');
    $bar.append('<button class="bm-btn" id="bm-sel-rec"><i class="fa-solid fa-star"></i> Recommended</button>');
    $bar.append('<button class="bm-btn" id="bm-refresh-counts"><i class="fa-solid fa-rotate"></i> Counts</button>');
    $tab.append($bar);

    const $list = $('<div class="bm-catlist">');
    for (const cat of REGISTRY) {
        const exportable = cat.stage2Export;
        // Default selection skips experimental categories.
        const checkedDefault = exportable && cat.defaultEnabled && !cat.experimental;
        const $row = $('<label class="bm-catrow">').toggleClass('bm-disabled', !exportable);
        const $cb = $('<input type="checkbox">').attr('id', `bm-cat-${cat.id}`).prop('checked', checkedDefault).prop('disabled', !exportable);
        $row.append($cb);
        $row.append($('<span class="bm-catname">').text(cat.label));
        $row.append($('<span class="bm-count">').attr('id', `bm-count-${cat.id}`).text('—'));
        // Status pill: later | experimental | settings | list | risk level.
        if (!exportable) $row.append('<span class="bm-tag tbd">later</span>');
        else if (cat.experimental) $row.append('<span class="bm-tag experimental">experimental</span>');
        else if (cat.kind === 'settings') $row.append('<span class="bm-tag info">settings</span>');
        else if (cat.kind === 'list') $row.append('<span class="bm-tag info">links</span>');
        else $row.append($(`<span class="bm-tag ${cat.risk === 'high' ? 'danger' : cat.risk === 'med' ? 'warn' : 'safe'}">`).text(cat.risk));
        if (cat.warning) $row.attr('title', cat.warning);
        $list.append($row);
    }
    $tab.append($list);

    // Show the never-exported categories so the scope is clear (IDs only).
    $tab.append($('<div class="bm-excluded">').text('Never exported: ' + EXCLUDED.map(e => e.id).join(', ') + '.'));

    const $actions = $('<div class="bm-actions">');
    $actions.append('<button class="bm-btn primary" id="bm-export-go"><i class="fa-solid fa-file-zipper"></i> Create backup ZIP</button>');
    $actions.append('<button class="bm-btn" id="bm-verify-btn"><i class="fa-solid fa-circle-check"></i> Verify backup</button>');
    $actions.append('<button class="bm-btn danger" id="bm-cancel-btn" style="display:none"><i class="fa-solid fa-stop"></i> Cancel</button>');
    $tab.append($actions);

    $tab.append('<div id="bm-progress"><div id="bm-bar"><div id="bm-bar-fill"></div></div><span id="bm-status"></span></div>');
    return $tab;
}

// ─── Verify backup ───
// Read-only integrity check of a user-chosen ZIP: the manifest parses, every
// listed file is present, and each sha256 still matches. Writes nothing.
async function verifyBackup() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.zip' });
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (!(await ensureZip())) { exportUi.error('Local JSZip not available.'); return; }
        try {
            const zip = await JSZip.loadAsync(file);
            const mf = zip.file('backup-manifest.json');
            if (!mf) { exportUi.error('No backup-manifest.json found.'); return; }
            const manifest = JSON.parse(await mf.async('string'));
            let okHash = 0, badHash = 0, missing = 0;
            for (const pf of (manifest.perFile || [])) {
                const entry = zip.file(pf.path);
                if (!entry) { missing++; continue; }
                if (pf.hash) {
                    const buf = await entry.async('arraybuffer');
                    const h = await sha256(buf);
                    if (h === pf.hash) okHash++; else badHash++;
                }
            }
            const verdict = (missing === 0 && badHash === 0) ? 'restorable' : 'PROBLEMS';
            exportUi.status(`Verify: ${verdict} — files ok:${okHash} bad:${badHash} missing:${missing} (schema v${manifest.schemaVersion})`);
            (window.toastr || console).info?.(`Backup verify: ${verdict}`);
        } catch (e) { exportUi.error(`Verify failed: ${redact(e.message)}`); }
    };
    input.click();
}

// ─── Panel mount ───
function buildUI() {
    const $root = $('<div id="bm-root">').attr('data-bm-build', buildMarker());
    const $drawer = $('<div class="inline-drawer">');
    const $header = $('<div class="inline-drawer-toggle inline-drawer-header">')
        .append('<b>⊹ BACKUP MANAGER ⊹</b>')
        .append('<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>');
    const $content = $('<div class="inline-drawer-content">');

    $content.append(buildExportTab());

    $drawer.append($header, $content);
    $root.append($drawer);
    $('#extensions_settings2').append($root);

    // Selection buttons
    $('#bm-sel-all').on('click', () => REGISTRY.forEach(c => c.stage2Export && $(`#bm-cat-${c.id}`).prop('checked', true)));
    $('#bm-sel-none').on('click', () => REGISTRY.forEach(c => $(`#bm-cat-${c.id}`).prop('checked', false)));
    $('#bm-sel-rec').on('click', () => REGISTRY.forEach(c => $(`#bm-cat-${c.id}`).prop('checked', c.stage2Export && c.defaultEnabled && !c.experimental)));
    $('#bm-refresh-counts').on('click', refreshCounts);

    // Actions
    $('#bm-export-go').on('click', async () => {
        const ids = getSelectedExportIds();
        if (!ids.length) { exportUi.error('Select at least one category.'); return; }
        // Extra confirmation when private chats are selected.
        if (ids.includes('chats')) {
            const msg = 'You selected CHATS. The backup will contain private conversations (roleplay, persona data, names, prompts, sensitive content). Continue?';
            let ok = true;
            try {
                if (ctx.Popup?.show?.confirm) ok = await ctx.Popup.show.confirm('Export private chats?', msg);
                else ok = window.confirm(msg);
            } catch { ok = window.confirm(msg); }
            if (!ok) { exportUi.status('Export cancelled.'); return; }
        }
        runExport(ids, exportUi);
    });
    $('#bm-verify-btn').on('click', verifyBackup);
    $('#bm-cancel-btn').on('click', () => { _abort = true; exportUi.status('Cancelling…'); });
}

buildUI();
log(`v${MODULE_VERSION} loaded (export-only).`);
