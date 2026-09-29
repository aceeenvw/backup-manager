// ⊹ BACKUP MANAGER ⊹ — aceenvw
import { safeName, pathKey, validPath, allocatePath, cleanPreset, dataSize, validateManifest, inspectZip, readZipEntry, MAX_FILES, MAX_METADATA } from './backup-core.mjs';
import { getCurrentLocale } from '../../../i18n.js';
import { translate } from './locales.mjs';

const MODULE_NAME = 'backup_manager';
const MODULE_VERSION = '1.1.0';
const SCHEMA_VERSION = 2;
const REGISTRY_VERSION = 4;

// Only OpenAI / chat-completion presets are exported. Other preset APIs
// (textgen, kobold, novel, context, instruct, etc.) are intentionally skipped.
const PRESET_API_IDS = ['openai'];

let ctx = SillyTavern.getContext();
let operation = null;
let enabled = false;
let readySource = null;
let lifecycle = 0;
const downloadUrls = new Set();
const downloadTimers = new Set();
const tr = (key, ...values) => translate(getCurrentLocale(), key, ...values);
const formatSize = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;

function preferences() {
    const saved = ctx.extensionSettings?.[MODULE_NAME];
    return saved && typeof saved === 'object' ? saved : {};
}

function savePreferences(patch) {
    ctx = SillyTavern.getContext();
    ctx.extensionSettings[MODULE_NAME] = { ...preferences(), ...patch };
    ctx.saveSettingsDebounced();
}

function byteLimit() {
    const value = Number($('#bm-size-limit').val() ?? preferences().maxMiB ?? 256);
    return Math.min(2048, Math.max(32, Number.isFinite(value) ? value : 256)) * 1048576;
}

function checkCancelled() {
    if (operation?.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (operation?.limitError) throw operation.limitError;
}

function addFile(files, path, data, source = null) {
    checkCancelled();
    const size = dataSize(data);
    if (operation && (operation.bytes + size > operation.maxBytes || operation.files >= MAX_FILES - (operation.category ? 2 : 1))) {
        operation.limitError = new Error(tr('limitReached'));
        throw operation.limitError;
    }
    const allocated = allocatePath(path, operation?.paths ?? new Set(files.map(file => pathKey(file.path))));
    files.push({ path: allocated, data, size, source, category: operation?.category ?? null });
    if (operation) { operation.bytes += size; operation.files++; }
    return allocated;
}

function folderPath(path) {
    return allocatePath(path, operation?.folders ?? new Set());
}

async function request(url, options = {}, mode = 'json') {
    checkCancelled();
    const controller = new AbortController();
    const parent = operation?.controller.signal;
    const abort = () => controller.abort();
    parent?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 60000);
    try {
        const response = await fetch(url, { ...options, headers: headers(), signal: controller.signal });
        if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
        const max = Math.min(operation?.maxBytes ?? byteLimit(), mode === 'json' && url !== '/api/chats/export' ? MAX_METADATA : Infinity);
        const limitMessage = () => tr(mode === 'json' && url !== '/api/chats/export' ? 'metadataLimit' : 'limitReached');
        const declared = Number(response.headers.get('content-length'));
        if (declared > max) throw new Error(limitMessage());
        const chunks = [];
        let size = 0;
        if (response.body) {
            const reader = response.body.getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > max) { await reader.cancel(); throw new Error(limitMessage()); }
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
        } else {
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength > max) throw new Error(limitMessage());
            chunks.push(buffer);
        }
        checkCancelled();
        const blob = new Blob(chunks, { type: response.headers.get('content-type') || '' });
        return mode === 'blob' ? blob : JSON.parse(await blob.text());
    } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}

function buildMarker() {
    const h = (MODULE_NAME + MODULE_VERSION).split('').reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(36);
    return btoa(JSON.stringify({ a: atob('YWNlZW52dw=='), v: MODULE_VERSION, h }));
}

// ─── Logging ───
const SECRET_RX = /(sk-[A-Za-z0-9]{8,})|(bearer\s+[A-Za-z0-9._-]{8,})|([A-Za-z0-9._-]{40,})|(https?:\/\/[^/\s]*:[^/@\s]*@)/gi;
function redact(s) {
    return String(s ?? '').replace(SECRET_RX, '[REDACTED]');
}
function warn(scope, error) { console.warn('[BM]', scope, new Error(redact(error?.message ?? error))); }

// ─── Request headers ───
// Reuse ST's helper (CSRF token + cookie). User isolation is enforced by the
// server from the session; we never pass a user handle.
function headers() {
    return SillyTavern.getContext().getRequestHeaders();
}

// ─── JSZip loader (LOCAL ONLY — no CDN fallback) ───
// Loads SillyTavern's bundled JSZip. If it is missing, export stops with an
// error; we never fetch a remote copy.
let zipPromise = null;
let zipScript = null;
let cancelZipLoad = null;
async function ensureZip() {
    if (window.JSZip) return true;
    if (zipPromise) return zipPromise;
    zipPromise = new Promise(resolve => {
        const script = document.createElement('script');
        const parent = operation?.controller.signal;
        let settled = false;
        zipScript = script;
        const finish = ok => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            parent?.removeEventListener('abort', abort);
            script.onload = script.onerror = null;
            script.remove();
            zipScript = cancelZipLoad = null;
            resolve(ok && Boolean(window.JSZip));
        };
        const timer = setTimeout(() => finish(false), 15000);
        const abort = () => finish(false);
        parent?.addEventListener('abort', abort, { once: true });
        cancelZipLoad = () => finish(false);
        script.src = '/lib/jszip.min.js';
        script.onload = () => finish(true);
        script.onerror = () => finish(false);
        document.head.appendChild(script);
    });
    try { return await zipPromise; } finally { zipPromise = null; }
}

// ─── Utility helpers ───

// Trigger a browser download of a Blob.
function downloadBlob(blob, name) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    downloadUrls.add(a.href);
    const timer = setTimeout(() => { URL.revokeObjectURL(a.href); downloadUrls.delete(a.href); downloadTimers.delete(timer); }, 60000);
    downloadTimers.add(timer);
}

// Timestamp for the backup filename: YYYY-MM-DD-HH-mm.
function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}

// Make a string safe as a file/folder name: strip reserved chars and path
// traversal, escape Windows reserved names, cap length. Preserves Unicode.
const sanitize = safeName;

// SHA-256 hex digest of a Blob/ArrayBuffer/string (used for integrity only).
async function sha256(data) {
    let buf;
    if (data instanceof Blob) buf = await data.arrayBuffer();
    else if (typeof data === 'string') buf = new TextEncoder().encode(data);
    else buf = data;
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const REGISTRY = [
    { id: 'characters', defaultEnabled: true, list: listCharacters, exportFn: exportCharacters },
    { id: 'chats', private: true, unit: 'chatsUnit', list: listChats, exportFn: exportChats },
    { id: 'groups', private: true, list: listGroups, exportFn: exportGroups },
    { id: 'worlds', defaultEnabled: true, list: listWorlds, exportFn: exportWorlds },
    { id: 'backgrounds', defaultEnabled: true, list: listBackgrounds, exportFn: exportBackgrounds },
    { id: 'themes', defaultEnabled: true, list: listThemes, exportFn: exportThemes },
    { id: 'presets', defaultEnabled: true, list: listPresets, exportFn: exportPresets },
    { id: 'personas', private: true, list: listPersonas, exportFn: exportPersonas },
    { id: 'persona-images', defaultEnabled: true, list: listPersonaImages, exportFn: exportPersonaImages },
    { id: 'user-images', unit: 'foldersUnit', list: listUserImages, exportFn: exportUserImages },
    { id: 'regex', list: listRegex, exportFn: exportRegex },
    { id: 'extension-list', list: listExtensions, exportFn: exportExtensionList },
];

// ─── Counts (scan only) ───

async function postJson(url, body) {
    return request(url, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

async function settingsResponse() {
    if (!operation) return postJson('/api/settings/get', {});
    operation.settingsPromise ??= postJson('/api/settings/get', {});
    return operation.settingsPromise;
}

async function fetchPowerUser() {
    return operation?.snapshot?.power_user ?? SillyTavern.getContext().powerUserSettings ?? {};
}

async function fetchExtensionSettings() {
    return operation?.snapshot?.extension_settings ?? SillyTavern.getContext().extensionSettings ?? {};
}


async function listCharacters() {
    return { count: (ctx.characters ?? []).filter(character => character.avatar).length };
}

async function listChats() {
    let count = 0;
    for (const character of ctx.characters ?? []) {
        checkCancelled();
        if (!character.avatar) continue;
        count += (await characterChats(character.avatar)).length;
    }
    checkCancelled();
    return { count };
}

async function characterChats(avatar) {
    const data = await postJson('/api/characters/chats', { avatar_url: avatar, simple: true });
    if (data?.error === true) return [];
    if (!Array.isArray(data) || data.some(entry => typeof entry?.file_name !== 'string' || !entry.file_name.endsWith('.jsonl'))) throw new Error('Invalid character chat listing');
    return data;
}

async function listGroups() {
    return { count: (await groupDefinitions()).length };
}

async function groupDefinitions() {
    const groups = await postJson('/api/groups/all', {});
    if (!Array.isArray(groups)) throw new Error('Invalid group listing');
    return groups;
}

async function listWorlds() {
    return { count: ((await settingsResponse()).world_names ?? []).length };
}

async function listBackgrounds() {
    const data = await postJson('/api/backgrounds/all', {});
    return { count: (Array.isArray(data) ? data : data.images ?? []).length };
}

async function listThemes() {
    return { count: (await getThemes()).length };
}

async function getThemes() {
    const data = await settingsResponse();
    if (!Array.isArray(data.themes)) throw new Error('Invalid theme listing');
    return data.themes;
}

async function listPresets() {
    return { count: PRESET_API_IDS.reduce((sum, api) => sum + ctx.getPresetManager(api).getAllPresets().length, 0) };
}

async function listPersonas() {
    return { count: Object.keys((await fetchPowerUser()).personas ?? {}).length };
}

async function listPersonaImages() {
    return { count: (await postJson('/api/avatars/get', {})).length };
}

async function listUserImages() {
    return { count: (await postJson('/api/images/folders', {})).length };
}

async function listRegex() {
    return { count: ((await fetchExtensionSettings()).regex ?? []).length };
}

async function listExtensions() {
    return { count: (await request('/api/extensions/discover')).length };
}

// ─── Export collectors ───
// Collectors return ZIP files and per-item warnings.

async function postBlob(url, body) {
    return request(url, { method: 'POST', body: JSON.stringify(body ?? {}) }, 'blob');
}

async function exportCharacters(onItem) {
    const chars = (ctx.characters || []).filter(c => c.avatar);
    const files = [], warnings = [];
    for (let i = 0; i < chars.length; i++) {
        checkCancelled();
        const c = chars[i];
        onItem?.();
        try {
            const blob = await postBlob('/api/characters/export', { avatar_url: c.avatar, format: 'png' });
            addFile(files, `characters/${sanitize(c.avatar)}`, blob, { avatar: c.avatar, name: c.name });
        } catch (e) { warnings.push(`character ${sanitize(c.name || '?')}: ${redact(e.message)}`); }
    }
    return { files, warnings };
}

async function exportWorlds(onItem) {
    const files = [], warnings = [];
    let names = [];
    try { const d = await settingsResponse(); names = d?.world_names || []; }
    catch (e) { return { files, warnings: [`worlds list: ${redact(e.message)}`] }; }
    for (let i = 0; i < names.length; i++) {
        checkCancelled();
        onItem?.();
        try {
            const data = await postJson('/api/worldinfo/get', { name: names[i] });
            addFile(files, `worlds/${sanitize(names[i])}.json`, JSON.stringify(data), { name: names[i] });
        } catch (e) { warnings.push(`world ${sanitize(names[i])}: ${redact(e.message)}`); }
    }
    return { files, warnings };
}

async function exportBackgrounds(onItem) {
    const files = [], warnings = [];
    let imgs = [];
    try { const d = await postJson('/api/backgrounds/all', {}); imgs = Array.isArray(d) ? d : (d?.images || []); }
    catch (e) { return { files, warnings: [`backgrounds list: ${redact(e.message)}`] }; }
    for (let i = 0; i < imgs.length; i++) {
        checkCancelled();
        const bg = typeof imgs[i] === 'string' ? imgs[i] : (imgs[i]?.filename || imgs[i]?.name);
        if (!bg) continue;
        onItem?.();
        try {
            const blob = await request(`/backgrounds/${encodeURIComponent(bg)}`, {}, 'blob');
            addFile(files, `backgrounds/${sanitize(bg)}`, blob, { filename: bg });
        } catch (e) { warnings.push(`background ${sanitize(bg)}: ${redact(e.message)}`); }
    }
    return { files, warnings };
}

async function exportThemes(onItem) {
    const files = [], warnings = [];
    let themes = [];
    try {
        themes = await getThemes();
    } catch (e) { return { files, warnings: [`themes: ${redact(e.message)}`] }; }
    for (let i = 0; i < themes.length; i++) {
        checkCancelled();
        onItem?.();
        const t = themes[i];
        addFile(files, `themes/${sanitize(t?.name || `theme-${i}`)}.json`, JSON.stringify(t), { name: t?.name ?? null });
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
    if (!keys.length) return { files, warnings };

    onItem?.();
    const bundle = {
        kind: 'personas-metadata',
        schema: 1,
        count: keys.length,
        default_persona: pu?.default_persona ?? null,
        personas,
        persona_descriptions: descriptions,
    };
    addFile(files, 'personas/personas.json', JSON.stringify(bundle, null, 2));
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
    if (!regex.length && !presets.length) return { files, warnings };

    onItem?.();
    addFile(files, 'regexes/regexes.json', JSON.stringify(regex, null, 2));
    if (presets.length) {
        addFile(files, 'regexes/regex-presets.json', JSON.stringify(presets, null, 2));
    }
    return { files, warnings };
}

// One JSON file per preset, read through PresetManager (OpenAI only).
async function exportPresets(onItem) {
    const files = [], warnings = [];
    if (typeof ctx.getPresetManager !== 'function') return { files, warnings: ['presets: PresetManager unavailable'] };
    for (const apiId of PRESET_API_IDS) {
        checkCancelled();
        let mgr;
        try { mgr = ctx.getPresetManager(apiId); } catch (error) { warnings.push(redact(error.message)); continue; }
        if (!mgr || typeof mgr.getAllPresets !== 'function') { warnings.push(`Preset manager unavailable: ${apiId}`); continue; }
        let names = [];
        try { names = mgr.getAllPresets() || []; } catch (error) { warnings.push(redact(error.message)); continue; }
        for (const nm of names) {
            checkCancelled();
            try {
                const data = mgr.getCompletionPresetByName(nm);
                if (data == null) throw new Error('Stored preset unavailable');
                addFile(files, `presets/${sanitize(apiId)}/${sanitize(nm)}.json`, JSON.stringify(cleanPreset(data)), { api: apiId, name: nm });
            } catch (e) { warnings.push(`preset ${sanitize(apiId)}/${sanitize(nm)}: ${redact(e.message)}`); }
        }
        onItem?.();
    }
    return { files, warnings };
}

async function exportPersonaImages(onItem) {
    const files = [], warnings = [];
    let avatars = [];
    try { const d = await postJson('/api/avatars/get', {}); avatars = Array.isArray(d) ? d : []; }
    catch (e) { return { files, warnings: [`persona-images list: ${redact(e.message)}`] }; }
    for (let i = 0; i < avatars.length; i++) {
        checkCancelled();
        const av = avatars[i];
        onItem?.();
        try {
            const blob = await request(`/User Avatars/${encodeURIComponent(av)}`, {}, 'blob');
            addFile(files, `persona-images/${sanitize(av)}`, blob, { filename: av });
        } catch (e) { warnings.push(`persona-image ${sanitize(av)}: ${redact(e.message)}`); }
    }
    return { files, warnings };
}

async function exportUserImages(onItem) {
    const files = [], warnings = [];
    let folders = [];
    try {
        const d = await postJson('/api/images/folders', {});
        if (!Array.isArray(d)) throw new Error('Invalid gallery folder listing');
        folders = d;
    } catch (e) { return { files, warnings: [`user-images folders: ${redact(e.message)}`] }; }
    for (const folder of folders) {
        checkCancelled();
        const safeFolder = folderPath(`user-images/${sanitize(folder)}`);
        let listing = [];
        try { listing = await postJson('/api/images/list', { folder }); } catch (e) { warnings.push(`user-images ${sanitize(folder)}: ${redact(e.message)}`); continue; }
        if (!Array.isArray(listing)) { warnings.push(`user-images ${sanitize(folder)}: invalid image listing`); continue; }
        const arr = listing;
        for (const item of arr) {
            checkCancelled();
            const fn = item;
            if (typeof fn !== 'string' || !fn) { warnings.push('user-images: malformed listing entry'); continue; }
            onItem?.();
            try {
                const rel = `user/images/${encodeURIComponent(folder)}/${encodeURIComponent(fn)}`;
                const blob = await request(`/${rel}`, {}, 'blob');
                addFile(files, `${safeFolder}/${sanitize(fn)}`, blob, { folder, filename: fn });
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

async function exportExtensionList(onItem) {
    const files = [], warnings = [];
    let discovered = [];
    try {
        discovered = await request('/api/extensions/discover');
        if (!Array.isArray(discovered)) throw new Error('Invalid extension discovery response');
    } catch (e) { return { files, warnings: [`extension-list: ${redact(e.message)}`] }; }

    const names = (Array.isArray(discovered) ? discovered : []).map(x => ({
        name: typeof x === 'string' ? x : (x?.name || ''),
        type: (x && x.type) || 'unknown',
    })).filter(x => x.name);

    const list = [];
    for (let i = 0; i < names.length; i++) {
        checkCancelled();
        const entry = names[i];
        onItem?.();
        let manifest = null;
        try {
            manifest = ctx.getExtensionManifest?.(entry.name);
            if (!manifest) manifest = await request(`/scripts/extensions/${entry.name.split('/').map(encodeURIComponent).join('/')}/manifest.json`);
        } catch (error) { warnings.push(`extension manifest ${entry.name}: ${redact(error.message)}`); }
        list.push({ name: entry.name, type: entry.type, homePage: safeHttpUrl(manifest?.homePage), version: manifest?.version ?? null, enabled: !(ctx.extensionSettings.disabledExtensions ?? []).includes(entry.name), manifestReadable: Boolean(manifest) });
    }

    addFile(files, 'extensions-links.json', JSON.stringify({ extensions: list }, null, 2));
    return {
        files,
        warnings,
        links: list,
    };
}

// Export chats: for each character, fetch its chat list, then each chat file.
// Progress reports counts only — never chat names or content. A per-character
// _mapping.json records the character id/name for a manual restore.
async function exportChats(onItem) {
    const chars = (ctx.characters || []).filter(c => c.avatar);
    const files = [], warnings = [];

    for (let i = 0; i < chars.length; i++) {
        checkCancelled();
        const c = chars[i];
        onItem?.();

        let list = null;
        try {
            list = await characterChats(c.avatar);
        } catch (e) { warnings.push(`chats(list): ${redact(e.message)}`); continue; }
        if (!list || !list.length) continue;

        const safeId = folderPath(`chats/${sanitize(c.avatar.replace(/\.[^.]+$/, ''))}`);
        let savedForChar = 0;

        for (let j = 0; j < list.length; j++) {
            checkCancelled();
            const fn = list[j]?.file_name;
            if (typeof fn !== 'string') { warnings.push('chats: malformed listing entry'); continue; }
            const cleanName = String(fn).replace(/\.jsonl$/i, '');
            onItem?.();
            try {
                const data = await postJson('/api/chats/export', { file: `${cleanName}.jsonl`, avatar_url: c.avatar, is_group: false, format: 'jsonl', exportfilename: 'backup.jsonl' });
                if (typeof data?.result !== 'string') throw new Error('Invalid raw chat export');
                const content = data.result;
                addFile(files, `${safeId}/${sanitize(cleanName)}.jsonl`, content, { avatar: c.avatar, filename: `${cleanName}.jsonl` });
                savedForChar++;
            } catch (e) { warnings.push(`chats(get): ${redact(e.message)}`); }
        }

        if (savedForChar > 0) {
            // Restore-mapping metadata (no chat content).
            const mapping = { kind: 'character-chats', characterId: c.avatar, characterName: c.name || null, chatCount: savedForChar };
            mapping.files = files.filter(file => file.source?.avatar === c.avatar).map(file => ({ path: file.path, filename: file.source.filename }));
            addFile(files, `${safeId}/_mapping.json`, JSON.stringify(mapping, null, 2));
        }
    }
    return { files, warnings };
}

async function exportGroups(onItem) {
    const groups = await groupDefinitions();
    const files = [], warnings = [], mappings = [];
    const chats = new Map();
    for (let i = 0; i < groups.length; i++) {
        checkCancelled();
        const group = groups[i];
        if (!group || !['string', 'number'].includes(typeof group.id) || !String(group.id)) {
            warnings.push('groups: malformed definition');
            continue;
        }
        onItem?.();
        const definition = structuredClone(group);
        for (const key of ['date_added', 'create_date', 'date_last_chat', 'chat_size']) delete definition[key];
        const filename = sanitize(`${group.id}.json`);
        const path = addFile(files, `groups/${pathKey(filename) === '_mapping.json' ? '_' + filename : filename}`, JSON.stringify(definition, null, 2), { groupId: group.id, filename: `${group.id}.json` });
        const mapping = { groupId: group.id, definition: path, members: group.members ?? [], chats: [] };
        mappings.push(mapping);
        if (group.chats != null && !Array.isArray(group.chats)) warnings.push(`groups: malformed chat list for ${group.id}`);
        const references = new Set();
        for (const id of [...(Array.isArray(group.chats) ? group.chats : []), group.chat_id]) {
            if (id == null || id === '') continue;
            if (!['string', 'number'].includes(typeof id)) { warnings.push(`groups: malformed chat reference for ${group.id}`); continue; }
            references.add(String(id));
        }
        for (const id of references) {
            checkCancelled();
            onItem?.();
            const filename = `${id}.jsonl`;
            if (!chats.has(id)) {
                try {
                    const data = await postJson('/api/chats/export', { file: filename, is_group: true, format: 'jsonl', exportfilename: 'backup.jsonl' });
                    if (typeof data?.result !== 'string') throw new Error('Invalid raw group chat export');
                    const chatPath = addFile(files, `group-chats/${sanitize(filename)}`, data.result, { chatId: id, filename });
                    chats.set(id, { chatId: id, filename, path: chatPath });
                } catch (error) {
                    checkCancelled();
                    warnings.push(`group chat ${id}: ${redact(error.message)}`);
                    chats.set(id, { chatId: id, filename, path: null });
                }
            }
            mapping.chats.push(chats.get(id));
        }
    }
    if (mappings.length) addFile(files, 'groups/_mapping.json', JSON.stringify({ groups: mappings }, null, 2));
    return { files, warnings };
}
// ─── Manifest builder ───
// Builds backup-manifest.json: per-file path/size/sha256, counts, and metadata.
// Paths are relative; source metadata preserves original restore identities.
async function buildManifest(selectedIds, fileEntries, allWarnings, links) {
    const counts = {};
    const perFile = [];
    let totalUncompressedSize = 0;
    for (const f of fileEntries) {
        checkCancelled();
        const folder = f.path.split('/')[0];
        counts[folder] = (counts[folder] || 0) + 1;
        const size = f.size ?? dataSize(f.data);
        totalUncompressedSize += size;
        const hash = globalThis.crypto?.subtle ? await sha256(f.data) : null;
        checkCancelled();
        perFile.push({ path: f.path, size, hash, category: f.category, source: f.source });
    }
    return {
        schemaVersion: SCHEMA_VERSION,
        extensionVersion: MODULE_VERSION,
        stVersion: operation?.stVersion ?? null,
        registryVersion: REGISTRY_VERSION,
        createdISO: new Date().toISOString(),
        selectedCategories: selectedIds,
        counts,
        totalUncompressedSize,
        perFile,
        warnings: allWarnings,
        integrity: globalThis.crypto?.subtle ? 'sha256' : 'unavailable',
        extensionLinksSanitized: links || [],
        _meta: { build: buildMarker() },
    };
}

// ─── Export engine ───
// Runs the selected collectors, builds the manifest, packs the ZIP, downloads it,
// and reports progress/results through the ui controller.
async function runExport(selectedIds, ui) {
    if (!beginOperation(ui)) return;
    const job = operation;
    const allFiles = [], allWarnings = [], results = [];
    let links = [];
    try {
        if (selectedIds.includes('chats') || selectedIds.includes('groups')) {
            const confirmed = ctx.Popup?.show?.confirm ? await ctx.Popup.show.confirm(tr('chatConfirmTitle'), tr('chatConfirm')) : window.confirm(tr('chatConfirm'));
            if (!confirmed) { ui.status(tr('cancelled')); return; }
            checkCancelled();
        }
        ui.status(tr('loading'));
        if (!(await ensureZip())) throw new Error(tr('zipMissing'));
        checkCancelled();
        const cats = REGISTRY.filter(cat => selectedIds.includes(cat.id));
        if (!cats.length) throw new Error(tr('select'));
        if (selectedIds.includes('characters') || selectedIds.includes('chats')) ctx = { ...ctx, characters: (ctx.characters ?? []).map(character => ({ avatar: character.avatar, name: character.name })) };
        const pu = ctx.powerUserSettings ?? {}, es = ctx.extensionSettings ?? {};
        job.snapshot = structuredClone({ power_user: selectedIds.includes('personas') ? { personas: pu.personas, persona_descriptions: pu.persona_descriptions, default_persona: pu.default_persona } : {}, extension_settings: selectedIds.includes('regex') ? { regex: es.regex, regex_presets: es.regex_presets } : {} });
        try { job.stVersion = (await request('/version')).pkgVersion ?? null; }
        catch { checkCancelled(); allWarnings.push('SillyTavern version unavailable'); }
        for (let i = 0; i < cats.length; i++) {
            checkCancelled();
            const cat = cats[i];
            job.category = cat.id;
            const result = { id: cat.id, status: 'empty', files: 0, bytes: 0, warnings: [] };
            results.push(result);
            const update = () => ui.status(tr('collecting', tr(cat.id), job.files, formatSize(job.bytes)));
            update();
            ui.progress(Math.round(i / cats.length * 60));
            try {
                const collected = await cat.exportFn(update);
                checkCancelled();
                allFiles.push(...collected.files);
                result.files = collected.files.length;
                result.bytes = collected.files.reduce((sum, file) => sum + (file.size ?? dataSize(file.data)), 0);
                result.warnings = collected.warnings ?? [];
                result.status = result.warnings.length ? (result.files ? 'partial' : 'failed') : (result.files ? 'complete' : 'empty');
                allWarnings.push(...result.warnings);
                if (collected.links) links = collected.links;
            } catch (error) {
                checkCancelled();
                result.status = 'failed';
                result.warnings.push(redact(error.message));
                allWarnings.push(`${cat.id}: ${redact(error.message)}`);
            }
        }
        if (allFiles.length && !globalThis.crypto?.subtle) allWarnings.push(tr('noHashes'));
        const report = coverageReport(selectedIds, results, allWarnings);
        ui.report?.(report);
        if (!allFiles.length) throw new Error(tr('empty'));
        job.category = null;
        addFile(allFiles, 'backup-report.json', JSON.stringify(report, null, 2));
        ui.status(tr('manifest'));
        ui.progress(65);
        const manifest = await buildManifest(selectedIds, allFiles, allWarnings, links);
        const manifestText = JSON.stringify(manifest, null, 2);
        if (dataSize(manifestText) > MAX_METADATA || manifest.totalUncompressedSize + dataSize(manifestText) > job.maxBytes) throw new Error(tr('limitReached'));
        validateManifest(manifest, job.maxBytes);
        checkCancelled();
        const zip = new JSZip();
        zip.file('backup-manifest.json', manifestText, { createFolders: false });
        const paths = new Set(['backup-manifest.json']);
        for (const file of allFiles) {
            if (paths.has(pathKey(file.path))) throw new Error('Duplicate archive path');
            paths.add(pathKey(file.path));
            zip.file(file.path, file.data, { createFolders: false, compression: /\.(png|jpe?g|webp|gif|avif|mp4|webm|zip)$/i.test(file.path) ? 'STORE' : 'DEFLATE' });
        }
        allFiles.length = 0;
        const blob = await zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 3 } }, metadata => {
            ui.progress(65 + Math.round(metadata.percent * 0.35));
            if (!job.controller.signal.aborted) ui.status(tr('packing', Math.round(metadata.percent)));
        });
        checkCancelled();
        downloadBlob(blob, `sillytavern-backup-${stamp()}.zip`);
        try { savePreferences({ lastDownloadISO: new Date().toISOString() }); renderLastDownload(); }
        catch (error) { warn('preferences', error); }
        ui[allWarnings.length ? 'warn' : 'success'](tr(allWarnings.length ? 'partial' : 'finished', manifest.perFile.length, formatSize(blob.size)));
    } catch (error) {
        if (results.length) ui.report?.(coverageReport(selectedIds, results, allWarnings, true));
        if (job.controller.signal.aborted) ui.status(tr('cancelled'));
        else { ui.error(tr('failed', redact(error.message))); warn('export', error); }
    } finally { endOperation(job, ui); }
}

function beginOperation(ui) {
    if (operation) { ui.status(tr('busy')); return false; }
    ctx = SillyTavern.getContext();
    operation = { controller: new AbortController(), paths: new Set(['backup-manifest.json']), folders: new Set(), bytes: 0, files: 0, maxBytes: byteLimit() };
    ui.lock();
    return true;
}

function endOperation(job, ui) {
    if (operation !== job) return;
    operation = null;
    ui.unlock();
}

const COVERAGE_NOTES = { chats: 'chatsScope', groups: 'groupScope', presets: 'presetScope', personas: 'personaScope', 'persona-images': 'personaScope', 'user-images': 'galleryScope', regex: 'regexScope', 'extension-list': 'extensionScope' };

function coverageReport(selectedIds, results, warnings, interrupted = false) {
    return {
        createdISO: new Date().toISOString(), selectedCategories: selectedIds, interrupted,
        files: results.reduce((sum, result) => sum + result.files, 0),
        bytes: results.reduce((sum, result) => sum + result.bytes, 0), warnings: [...warnings],
        categories: REGISTRY.map(cat => ({ ...(results.find(result => result.id === cat.id) ?? { id: cat.id, status: selectedIds.includes(cat.id) ? 'skipped' : 'notSelected', files: 0, bytes: 0, warnings: [] }), limitations: COVERAGE_NOTES[cat.id] ? { en: translate('en', COVERAGE_NOTES[cat.id]), ru: translate('ru', COVERAGE_NOTES[cat.id]) } : null })),
    };
}

// ─── UI controller ───
// Bridges the export engine to the DOM (buttons, status line, progress bar). All
// text is redacted before display.
const exportUi = {
    lock() { $('#bm-root button:not(#bm-cancel-btn),#bm-root input').prop('disabled', true); $('#bm-cancel-btn').show(); $('#bm-progress').addClass('active'); $('#bm-root').attr('aria-busy', 'true'); },
    unlock() { $('#bm-root button,#bm-root input').prop('disabled', false); $('#bm-cancel-btn').hide(); $('#bm-progress').removeClass('active'); $('#bm-root').attr('aria-busy', 'false'); this.progress(0); },
    status(t) { $('#bm-status').text(redact(t)); },
    progress(p) { $('#bm-bar-fill').css('width', `${p}%`); $('#bm-bar').attr('aria-valuenow', p); },
    success(m) { window.toastr?.success(redact(m)); this.status(m); },
    warn(m) { window.toastr?.warning(redact(m)); this.status(m); },
    error(m) { window.toastr?.error(redact(m)); this.status(m); },
    report: renderReport,
};

function getSelectedExportIds() {
    return REGISTRY.filter(c => $(`#bm-cat-${c.id}`).is(':checked')).map(c => c.id);
}

function renderLastDownload() {
    const date = new Date(preferences().lastDownloadISO);
    $('#bm-last-download').text(Number.isFinite(date.getTime()) ? tr('last', date.toLocaleString(getCurrentLocale() || 'en')) : tr('never'));
}

function renderReport(report) {
    const $report = $('#bm-report').empty().prop('hidden', false);
    $report.append($('<summary>').text(tr('report')));
    $report.append($('<p>').text(tr('reportSummary', report.files, formatSize(report.bytes), report.warnings.length)));
    const $list = $('<div class="bm-report-list">');
    for (const category of report.categories.filter(cat => cat.status !== 'notSelected')) {
        const $row = $('<div class="bm-report-row">');
        $row.append($('<strong>').text(tr(category.id)));
        $row.append($('<span>').text(`${tr(category.status === 'failed' ? 'failedState' : category.status === 'partial' ? 'partialState' : category.status === 'empty' ? 'emptyState' : category.status)} · ${category.files} · ${formatSize(category.bytes)}`));
        if (category.limitations) $row.append($('<small>').text(category.limitations[String(getCurrentLocale()).startsWith('ru') ? 'ru' : 'en']));
        $list.append($row);
    }
    $report.append($list);
    if (report.warnings.length) {
        const $warnings = $('<details class="bm-report-warnings">').append($('<summary>').text(tr('warningCount', report.warnings.length)));
        const $items = $('<ul>');
        for (const warning of report.warnings.slice(0, 100)) $items.append($('<li>').text(redact(warning)));
        $warnings.append($items);
        $report.append($warnings);
    }
}

// ─── UI build ───

// Update the item count next to each category using the list* helpers.
async function refreshCounts() {
    if (!beginOperation(exportUi)) return;
    const job = operation;
    try {
        for (const cat of REGISTRY) {
            checkCancelled();
            exportUi.status(tr('counting', tr(cat.id)));
            const $count = $(`#bm-count-${cat.id}`).text('…');
            try {
                const result = await cat.list();
                checkCancelled();
                $count.text(result.count == null ? '?' : tr(cat.unit ?? 'countsUnit', result.count));
            } catch (error) { checkCancelled(); $count.text('?'); warn('counts', error); }
        }
        exportUi.status(tr('countsDone'));
    } catch (error) {
        if (job.controller.signal.aborted) exportUi.status(tr('cancelled'));
        else exportUi.error(tr('failed', redact(error.message)));
    } finally { endOperation(job, exportUi); }
}

function buildExportTab() {
    const $tab = $('<div id="bm-tab-export" class="bm-tab">');
    $tab.append($('<p class="bm-intro">').text(tr('intro')));
    $tab.append($('<div class="bm-warning">').text(tr('privacy')));

    const $bar = $('<div class="bm-selbar">');
    $bar.append(button('bm-sel-all', 'all'), button('bm-sel-none', 'none'), button('bm-sel-rec', 'recommended'), button('bm-refresh-counts', 'counts').addClass('primary'));
    $tab.append($bar);

    const $list = $('<div class="bm-catlist">');
    for (const cat of REGISTRY) {
        const saved = preferences().selectedCategories;
        const checkedDefault = Array.isArray(saved) ? saved.includes(cat.id) : Boolean(cat.defaultEnabled);
        const $row = $('<label class="bm-catrow">');
        const $cb = $('<input type="checkbox">').attr('id', `bm-cat-${cat.id}`).prop('checked', checkedDefault);
        $row.append($cb);
        const $label = $('<span class="bm-catlabel">').append($('<span class="bm-catname">').text(tr(cat.id)));
        if (cat.private) $label.append($('<span class="bm-tag danger">').text(tr('private')));
        $row.append($label);
        $row.append($('<span class="bm-count">').attr('id', `bm-count-${cat.id}`).text('—'));
        $list.append($row);
    }
    $tab.append($list);

    $tab.append($('<div class="bm-excluded">').text(tr('excluded')));
    const $settings = $('<div class="bm-settings">');
    $settings.append($('<label for="bm-size-limit">').text(tr('limit')));
    $settings.append($('<input id="bm-size-limit" type="number" min="32" max="2048" step="1" inputmode="numeric" aria-describedby="bm-limit-hint">').val(preferences().maxMiB ?? 256));
    $settings.append($('<small id="bm-limit-hint">').text(tr('limitHint')));
    $tab.append($settings);

    const $actions = $('<div class="bm-actions">');
    $actions.append(button('bm-export-go', 'export').addClass('primary'), button('bm-verify-btn', 'verify'), button('bm-cancel-btn', 'cancel').addClass('danger').hide());
    $tab.append($actions);

    $tab.append('<div id="bm-progress"><div id="bm-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="bm-bar-fill"></div></div></div>');
    $tab.find('#bm-bar').attr('aria-label', tr('export'));
    $tab.append('<p id="bm-status" role="status" aria-live="polite" aria-atomic="true"></p><p id="bm-last-download" class="bm-intro"></p><details id="bm-report" hidden></details>');
    return $tab;
}

function button(id, key) {
    return $('<button type="button" class="bm-btn">').attr('id', id).text(tr(key));
}

// ─── Verify backup ───
// Read-only integrity check of a user-chosen ZIP: the manifest parses, every
// listed file is present, and each sha256 still matches. Writes nothing.
async function verifyBackup() {
    if (operation) { exportUi.status(tr('busy')); return; }
    const revision = lifecycle;
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.zip' });
    input.onchange = async () => {
        if (revision !== lifecycle) return;
        const file = input.files?.[0];
        if (!file) return;
        if (!beginOperation(exportUi)) return;
        const job = operation;
        try {
            if (!(await ensureZip())) throw new Error(tr('zipMissing'));
            checkCancelled();
            const entries = await inspectZip(file, job.maxBytes);
            checkCancelled();
            const zip = await JSZip.loadAsync(file);
            for (const [path, entry] of Object.entries(zip.files)) {
                const name = entry.dir ? path.replace(/\/$/, '') : path;
                if (!validPath(name) || (entry.unsafeOriginalName && entry.unsafeOriginalName !== path) || (!entry.dir && !entries.has(path))) throw new Error('ZIP paths changed while loading');
            }
            const mf = zip.file('backup-manifest.json');
            const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readZipEntry(mf, MAX_METADATA, job.controller.signal)));
            const manifestPaths = validateManifest(manifest, job.maxBytes);
            let okHash = 0, badHash = 0, missing = 0, unchecked = 0;
            const unexpected = [...entries.keys()].filter(path => !manifestPaths.has(pathKey(path))).length;
            for (let i = 0; i < manifest.perFile.length; i++) {
                checkCancelled();
                const pf = manifest.perFile[i];
                exportUi.status(tr('verifyProgress', i + 1, manifest.perFile.length));
                exportUi.progress(Math.round(i / manifest.perFile.length * 100));
                const entry = zip.file(pf.path);
                if (!entry) { missing++; continue; }
                if (entries.get(pf.path) !== pf.size) { badHash++; continue; }
                const buf = await readZipEntry(entry, pf.size, job.controller.signal);
                if (buf.byteLength !== pf.size) { badHash++; continue; }
                if (pf.hash && globalThis.crypto?.subtle) {
                    if (await sha256(buf) === pf.hash) okHash++; else badHash++;
                } else unchecked++;
            }
            checkCancelled();
            if (missing || badHash || unexpected) exportUi.error(tr('problems', missing, badHash, unexpected));
            else if (unchecked) exportUi.warn(tr('unverified', unchecked));
            else exportUi.success(tr('verified', okHash));
        } catch (error) {
            if (job.controller.signal.aborted || error.name === 'AbortError') exportUi.status(tr('cancelled'));
            else { exportUi.error(tr('failed', redact(error.message))); warn('verify', error); }
        } finally { endOperation(job, exportUi); }
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

    const persist = () => savePreferences({ selectedCategories: getSelectedExportIds() });
    $('#bm-sel-all,#bm-sel-none,#bm-sel-rec').on('click.bm', event => {
        for (const cat of REGISTRY) $(`#bm-cat-${cat.id}`).prop('checked', event.currentTarget.id === 'bm-sel-all' || (event.currentTarget.id === 'bm-sel-rec' && Boolean(cat.defaultEnabled)));
        persist();
    });
    $('#bm-root input[type="checkbox"]').on('change.bm', persist);
    $('#bm-size-limit').on('change.bm', () => {
        const maxMiB = Math.round(byteLimit() / 1048576);
        $('#bm-size-limit').val(maxMiB);
        savePreferences({ maxMiB });
    });
    $('#bm-refresh-counts').on('click.bm', refreshCounts);
    $('#bm-export-go').on('click.bm', async () => {
        const ids = getSelectedExportIds();
        if (!ids.length) { exportUi.error(tr('select')); return; }
        await runExport(ids, exportUi);
    });
    $('#bm-verify-btn').on('click.bm', verifyBackup);
    $('#bm-cancel-btn').on('click.bm', () => { operation?.controller.abort(); exportUi.status(tr('cancelling')); });
    renderLastDownload();
}

export function initialize() {
    if (enabled || document.getElementById('bm-root')) return;
    lifecycle++;
    enabled = true;
    buildUI();
    $('#bm-root button,#bm-root input').prop('disabled', true);
    ctx = SillyTavern.getContext();
    readySource = ctx.eventSource;
    readySource.on(ctx.eventTypes.APP_READY, onReady);
}

function onReady() {
    readySource?.removeListener(ctx.eventTypes.APP_READY, onReady);
    readySource = null;
    if (enabled && !operation) exportUi.unlock();
}

export function cleanup() {
    lifecycle++;
    enabled = false;
    operation?.controller.abort();
    readySource?.removeListener(ctx.eventTypes.APP_READY, onReady);
    readySource = null;
    $('#bm-root').find('*').addBack().off('.bm');
    $('#bm-root').remove();
    cancelZipLoad?.();
    zipScript?.remove();
    for (const timer of downloadTimers) clearTimeout(timer);
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadTimers.clear();
    downloadUrls.clear();
}

initialize();
