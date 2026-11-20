// ⊹ BACKUP MANAGER ⊹ — aceenvw
import { safeName, pathKey, allocatePath, cleanPreset, dataSize, MAX_METADATA } from './backup-core.mjs';
import { getCurrentLocale } from '../../../i18n.js';
import { translate } from './locales.mjs';

const MODULE_NAME = 'backup_manager';
const MODULE_VERSION = '1.1.0';

// Only OpenAI / chat-completion presets are exported. Other preset APIs
// (textgen, kobold, novel, context, instruct, etc.) are intentionally skipped.
const PRESET_API_IDS = ['openai'];

let ctx = SillyTavern.getContext();
let operation = null;
let enabled = false;
let readySource = null;
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


function checkCancelled() {
    if (operation?.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}

function addFile(files, path, data, source = null) {
    checkCancelled();
    const size = dataSize(data);
    const allocated = allocatePath(path, operation?.paths ?? new Set(files.map(file => pathKey(file.path))));
    files.push({ path: allocated, data, size, source });
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
        if (mode === 'blob') return await response.blob();
        const max = mode === 'json' && url !== '/api/chats/export' ? MAX_METADATA : Infinity;
        const limitMessage = () => tr("metadataLimit");
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
        return JSON.parse(await blob.text());
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


const REGISTRY = [
    { id: 'characters', list: listCharacters, exportFn: exportCharacters },
    { id: 'chats', unit: 'chatsUnit', list: listChats, exportFn: exportChats },
    { id: 'groups', list: listGroups, exportFn: exportGroups },
    { id: 'worlds', list: listWorlds, exportFn: exportWorlds },
    { id: 'backgrounds', list: listBackgrounds, exportFn: exportBackgrounds },
    { id: 'themes', list: listThemes, exportFn: exportThemes },
    { id: 'presets', list: listPresets, exportFn: exportPresets },
    { id: 'personas', list: listPersonas, exportFn: exportPersonas },
    { id: 'persona-images', list: listPersonaImages, exportFn: exportPersonaImages },
    { id: 'user-images', unit: 'foldersUnit', list: listUserImages, exportFn: exportUserImages },
    { id: 'memorybooks', list: async () => ({ count: ctx.extensionSettings?.STMemoryBooks ? 1 : null }), exportFn: exportMemoryBooks },
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


function scopedCards(key) {
    const ids = preferences()[key];
    const selected = Array.isArray(ids) ? new Set(ids) : null;
    return (ctx.characters ?? []).filter(c => c?.avatar && (!selected || selected.has(c.avatar)));
}

async function listCharacters() {
    return { count: scopedCards('cardAvatars').length };
}

async function listChats() {
    let count = 0;
    for (const character of scopedCards('chatAvatars')) {
        checkCancelled();
        if (!character.avatar) continue;
        count += (await scopedChats(character.avatar)).length;
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

async function scopedChats(avatar) {
    const chat = preferences().singleChat;
    return chat ? (chat.avatar === avatar ? [{file_name: chat.file}] : []) : characterChats(avatar);
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
    return { count: (await galleryFolders(true)).length };
}

async function galleryFolders(selectedOnly) {
    const folders = await postJson('/api/images/folders', {});
    if (!Array.isArray(folders) || !folders.every(name => typeof name === 'string' && name && !/[\\/]/.test(name) && name !== '.' && name !== '..')) throw new Error('Invalid gallery folder listing');
    const selected = preferences().galleryFolders;
    if (!selectedOnly || !Array.isArray(selected)) return folders;
    const allowed = new Set(selected);
    return folders.filter(name => allowed.has(name));
}

function scalarFields(value, keys) {
    return Object.fromEntries(keys.split(' ').filter(key => ['boolean', 'string', 'number'].includes(typeof value?.[key])).map(key => [key, value[key]]));
}

function sidePromptBackup(doc) {
    if (doc?.version !== 2 || !doc.prompts || typeof doc.prompts !== 'object' || Array.isArray(doc.prompts)) throw new Error('Unsupported MemoryBooks side-prompt format');
    const prompts = Object.create(null), sets = Object.create(null);
    for (const [key, p] of Object.entries(doc.prompts)) {
        if (p?.key !== key || typeof p.prompt !== 'string' || typeof p.enabled !== 'boolean' || !p.name) throw new Error('Invalid MemoryBooks prompt');
        const settings = scalarFields(p.settings, 'suggestionsPrompt saveAllVersions');
        if (p.settings?.lorebook) settings.lorebook = scalarFields(p.settings.lorebook, 'constVectMode position orderMode orderValue preventRecursion delayUntilRecursion ignoreBudget');
        const triggers = {};
        if (Array.isArray(p.triggers?.commands)) triggers.commands = p.triggers.commands.filter(x => typeof x === 'string');
        if (p.triggers?.onInterval) triggers.onInterval = scalarFields(p.triggers.onInterval, 'visibleMessages');
        if (p.triggers?.onAfterMemory) triggers.onAfterMemory = scalarFields(p.triggers.onAfterMemory, 'enabled');
        prompts[key] = { ...scalarFields(p, 'key name prompt enabled responseFormat specialKind createdAt updatedAt'), settings, triggers };
    }
    for (const [key, set] of Object.entries(doc.sets ?? {})) {
        if (set?.key !== key || !set.name || !Array.isArray(set.items)) throw new Error('Invalid MemoryBooks set');
        sets[key] = { ...scalarFields(set, 'key name createdAt updatedAt'), items: set.items.map(item => ({ ...scalarFields(item, 'id promptKey label'), runtimeMacros: Object.fromEntries(Object.entries(item.runtimeMacros ?? {}).filter(([token, value]) => /^\{\{.+\}\}$/.test(token) && typeof value === 'string' && !/key|secret|token|password|auth/i.test(token))) })) };
    }
    return { version: 2, prompts, sets };
}

async function exportMemoryBooks() {
    const files = [], warnings = [];
    const prefs = scalarFields(ctx.extensionSettings?.STMemoryBooks?.moduleSettings, 'alwaysUseDefault showMemoryPreviews showConsolidationPreviews showNotifications showFloatingClipButton maxTokens tokenWarningThreshold manualModeEnabled autoSummaryEnabled autoSummaryInterval autoSummaryTriggerMode autoSummaryTokenThreshold autoSummaryBuffer autoCreateLorebook characterAwareMemories useSeparateGroupSidePrompts');
    if (Object.keys(prefs).length) addFile(files, 'memorybooks/preferences.json', JSON.stringify(prefs, null, 2));
    try {
        const doc = await request('/user/files/stmb-side-prompts.json');
        addFile(files, 'memorybooks/stmb-side-prompts.json', JSON.stringify(sidePromptBackup(doc), null, 2));
    } catch (error) { checkCancelled(); warnings.push(redact(error.message)); }
    return { files, warnings };
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
    const chars = scopedCards('cardAvatars');
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
        folders = await galleryFolders(true);
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
    };
}

// Export chats: for each character, fetch its chat list, then each chat file.
// Progress reports counts only — never chat names or content. A per-character
// _mapping.json records the character id/name for a manual restore.
async function exportChats(onItem) {
    const chars = scopedCards('chatAvatars');
    const files = [], warnings = [];

    for (let i = 0; i < chars.length; i++) {
        checkCancelled();
        const c = chars[i];
        onItem?.();

        let list = null;
        try {
            list = await scopedChats(c.avatar);
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
async function runExport(selectedIds, ui, destination = null) {
    if (!beginOperation(ui)) return;
    const job = operation;
    const allFiles = [];
    let partial = false;
    try {
        ui.status(tr('loading'));
        if (!destination && !(await ensureZip())) throw new Error(tr('zipMissing'));
        checkCancelled();
        const cats = REGISTRY.filter(cat => selectedIds.includes(cat.id));
        if (!cats.length) throw new Error(tr('select'));
        if (selectedIds.includes('characters') || selectedIds.includes('chats')) ctx = { ...ctx, characters: (ctx.characters ?? []).map(character => ({ avatar: character.avatar, name: character.name })) };
        const pu = ctx.powerUserSettings ?? {}, es = ctx.extensionSettings ?? {};
        job.snapshot = structuredClone({ power_user: selectedIds.includes('personas') ? { personas: pu.personas, persona_descriptions: pu.persona_descriptions, default_persona: pu.default_persona } : {}, extension_settings: selectedIds.includes('regex') ? { regex: es.regex, regex_presets: es.regex_presets } : {} });
        for (let i = 0; i < cats.length; i++) {
            checkCancelled();
            const cat = cats[i];
            const update = () => ui.status(tr('collecting', tr(cat.id), job.files, formatSize(job.bytes)));
            update();
            ui.progress(Math.round(i / cats.length * 60));
            try {
                const collected = await cat.exportFn(update);
                checkCancelled();
                for (const file of collected.files) allFiles.push(file);
                if (collected.warnings?.length) partial = true;
            } catch (error) {
                checkCancelled();
                partial = true;
                warn(cat.id, error);
            }
        }
        if (!allFiles.length) throw new Error(tr('empty'));
        checkCancelled();
        if (destination) {
            const root = await destination.getDirectoryHandle(`sillytavern-backup-${stamp()}-${crypto.randomUUID()}`, {create: true});
            for (const [index, file] of allFiles.entries()) {
                checkCancelled();
                const parts = file.path.split('/');
                const name = parts.pop();
                let dir = root;
                for (const part of parts) dir = await dir.getDirectoryHandle(part, {create: true});
                const handle = await dir.getFileHandle(name, {create: true});
                const writer = await handle.createWritable();
                try { checkCancelled(); await writer.write(file.data); await writer.close(); }
                catch (error) { await writer.abort().catch(() => {}); throw error; }
                ui.progress(60 + Math.round(40 * (index + 1) / allFiles.length));
            }
            savePreferences({lastDownloadISO: new Date().toISOString()}); renderLastDownload();
            ui[partial ? 'warn' : 'success'](tr(partial ? 'folderPartial' : 'folderDone', allFiles.length));
            return;
        }
        const zip = new JSZip();
        const lowPower = window.matchMedia?.('(pointer: coarse)').matches;
        const paths = new Set();
        for (const file of allFiles) {
            if (paths.has(pathKey(file.path))) throw new Error('Duplicate archive path');
            paths.add(pathKey(file.path));
            zip.file(file.path, file.data, { createFolders: false, compression: lowPower || /\.(png|jpe?g|webp|gif|avif|mp4|webm|zip)$/i.test(file.path) ? 'STORE' : 'DEFLATE' });
        }
        const count = allFiles.length;
        allFiles.length = 0;
        let lastPercent = -1;
        const blob = await zip.generateAsync({ type: 'blob', streamFiles: true, compressionOptions: { level: 1 } }, metadata => {
            const percent = Math.round(metadata.percent);
            if (percent === lastPercent || job.controller.signal.aborted) return;
            lastPercent = percent;
            ui.progress(65 + Math.round(metadata.percent * 0.35));
            ui.status(tr('packing', percent));
        });
        checkCancelled();
        downloadBlob(blob, `sillytavern-backup-${stamp()}.zip`);
        try { savePreferences({ lastDownloadISO: new Date().toISOString() }); renderLastDownload(); }
        catch (error) { warn('preferences', error); }
        ui[partial ? 'warn' : 'success'](tr(partial ? 'partial' : 'finished', count, formatSize(blob.size)));
    } catch (error) {
        if (job.controller.signal.aborted) ui.status(tr('cancelled'));
        else { ui.error(tr('failed', redact(error.message))); warn('export', error); }
    } finally { endOperation(job, ui); }
}

function beginOperation(ui) {
    if (operation) { ui.status(tr('busy')); return false; }
    ctx = SillyTavern.getContext();
    operation = { controller: new AbortController(), paths: new Set(), folders: new Set(), bytes: 0, files: 0 };
    ui.lock();
    return true;
}

function endOperation(job, ui) {
    if (operation !== job) return;
    operation = null;
    ui.unlock();
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
};

function getSelectedExportIds() {
    return REGISTRY.filter(c => $(`#bm-cat-${c.id}`).is(':checked')).map(c => c.id);
}

function renderLastDownload() {
    const date = new Date(preferences().lastDownloadISO);
    const locale = getCurrentLocale() || 'en';
    const valid = Number.isFinite(date.getTime());
    const full = valid ? tr('last', date.toLocaleString(locale)) : tr('never');
    $('#bm-last-download').attr({ title: full, 'aria-label': full }).text(valid ? date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : tr('never'));
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

    const $bar = $('<div class="bm-selbar">');
    $bar.append(button('bm-sel-toggle', 'all'), $('<span class="bm-last-badge">').append('<i class="fa-regular fa-clock" aria-hidden="true"></i><span id="bm-last-download"></span>'), button('bm-refresh-counts', 'counts').attr({title: tr('counts'), 'aria-label': tr('counts')}).empty().append('<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>'));
    $tab.append($bar);

    const $list = $('<div class="bm-catlist">');
    for (const cat of REGISTRY) {
        const saved = preferences().selectedCategories;
        const checkedDefault = Array.isArray(saved) && saved.includes(cat.id);
        const $row = $('<label class="bm-catrow">');
        const $cb = $('<input type="checkbox">').attr('id', `bm-cat-${cat.id}`).prop('checked', checkedDefault);
        $row.append($cb);
        const $label = $('<span class="bm-catlabel">').append($('<span class="bm-catname">').text(tr(cat.id)));
        $row.append($label);
        $row.append($('<span class="bm-count">').attr('id', `bm-count-${cat.id}`).text('—'));
        if (['characters', 'chats', 'user-images'].includes(cat.id)) {
            const { $choose, $options } = buildPicker(cat.id);
            $list.append($('<div class="bm-catrow bm-picker-row">').append($row.removeClass('bm-catrow'), $choose), $options);
        } else $list.append($row);
    }
    $tab.append($list);


    const $actions = $('<div class="bm-actions">');
    $actions.append(button('bm-export-go', 'export').addClass('primary'), button('bm-cancel-btn', 'cancel').addClass('danger').hide());
    $tab.append($actions);
    $tab.append(buildTransferTools());

    $tab.append('<div id="bm-progress"><div id="bm-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="bm-bar-fill"></div></div></div>');
    $tab.find('#bm-bar').attr('aria-label', tr('export'));
    $tab.append('<p id="bm-status" role="status" aria-live="polite" aria-atomic="true"></p>');
    return $tab;
}

function button(id, key) {
    return $('<button type="button" class="bm-btn">').attr('id', id).text(tr(key));
}

function buildTransferTools() {
    const $tools = $('<details class="bm-transfer">').append($('<summary>').append('<i class="fa-solid fa-folder-open" aria-hidden="true"></i>', $('<span>').text(tr('transferTools')), '<i class="fa-solid fa-chevron-down bm-chevron" aria-hidden="true"></i>'));
    const $input = $('<input type="file" multiple hidden accept=".png,.json">');
    const $import = button('bm-import-cards', 'importCards');
    async function importCards(files) {
        const cards = Array.from(files).filter(f => /\.(png|json)$/i.test(f.name));
        if (!cards.length) { exportUi.status(tr('pickCards')); return; }
        if (!beginOperation(exportUi)) return;
        const job = operation;
        try {
            $('#bm-cancel-btn').hide();
            const { processDroppedFiles } = await import('../../../../script.js');
            checkCancelled();
            const typed = cards.map(f => {
                const type = /\.png$/i.test(f.name) ? 'image/png' : 'application/json';
                return f.type === type ? f : new File([f], f.name, {type});
            });
            await processDroppedFiles(typed);
            if (enabled) exportUi.status(tr('importFinished'));
        } catch (error) { if (!job.controller.signal.aborted) exportUi.error(tr('failed', redact(error.message))); }
        finally { endOperation(job, exportUi); }
    }
    $input.on('change.bm', event => { const files = Array.from(event.target.files); event.target.value = ''; if (files.length) void importCards(files); });
    $import.on('click.bm', () => $input[0].click()).on('dragover.bm drop.bm', e => {
        e.preventDefault(); e.stopPropagation();
        if (e.type === 'drop') void importCards(e.originalEvent.dataTransfer.files);
    });
    const $chat = button('bm-download-chat', 'downloadChat').on('click.bm', async () => {
        if (!beginOperation(exportUi)) return;
        const job = operation;
        try {
            const id = ctx.getCurrentChatId?.();
            const group = ctx.groupId != null && ctx.groupId !== '';
            const avatar = ctx.characters?.[ctx.characterId]?.avatar;
            if (!id || (!group && !avatar)) { exportUi.status(tr('openChat')); return; }
            const file = `${String(id).replace(/\.jsonl$/i, '')}.jsonl`;
            const data = await postJson('/api/chats/export', {file, avatar_url: group ? '' : avatar, is_group: group, format: 'jsonl', exportfilename: 'backup.jsonl'});
            checkCancelled();
            if (typeof data?.result !== 'string') throw new Error('Invalid chat export');
            downloadBlob(new Blob([data.result]), sanitize(file));
            exportUi.status(tr('chatDownloaded'));
        } catch (error) { if (!job.controller.signal.aborted) exportUi.error(tr('failed', redact(error.message))); }
        finally { endOperation(job, exportUi); }
    });
    const $actions = $('<div class="bm-actions">').append($input, $import, $chat);
    if (typeof window.showDirectoryPicker === 'function') $actions.append(button('bm-save-folder', 'saveFolder').on('click.bm', async () => {
        const ids = getSelectedExportIds();
        if (!ids.length) { exportUi.status(tr('select')); return; }
        try { const dir = await window.showDirectoryPicker({mode: 'readwrite'}); if (enabled) await runExport(ids, exportUi, dir); }
        catch (error) { if (error.name !== 'AbortError') exportUi.error(tr('failed', redact(error.message))); }
    }));
    return $tools.append($('<div class="bm-transfer-body">').append($('<p class="bm-transfer-hint">').text(tr('transferHint')), $actions));
}

// ─── Panel mount ───
function buildPicker(category) {
    const gallery = category === 'user-images', chats = category === 'chats';
    const key = gallery ? 'galleryFolders' : chats ? 'chatAvatars' : 'cardAvatars';
    const selected = () => preferences()[key];
    const save = (ids, singleChat = null) => savePreferences({ [key]: ids, ...(chats ? { singleChat } : {}) });
    const id = `bm-${category}-picker`, title = tr(gallery ? 'chooseFolders' : 'chooseCards');
    const $choose = button(`${id}-open`, 'all').addClass('bm-picker-open').attr({ title, 'aria-label': title, 'aria-expanded': 'false', 'aria-controls': id }).empty().append(`<i class="fa-solid ${gallery ? 'fa-folder-tree' : 'fa-address-card'}" aria-hidden="true"></i>`);
    const $all = button(`${id}-toggle`, 'all').addClass('bm-picker-toggle');
    const $options = $('<div class="bm-picker">').attr('id', id).hide();
    const searchLabel = tr(gallery ? 'findFolder' : 'findCard');
    const $search = $('<input type="search" class="text_pole">').attr({placeholder: searchLabel, 'aria-label': searchLabel});
    const labels = new Map(), tags = new Map();
    const $scope = $('<small class="bm-scope">');
    const $rows = $('<div class="bm-folder-rows">');
    let names = [], matches = [], rendered = 0, chosen = new Set();
    let all = false;
    function syncToggle() { $all.text(tr(all ? 'none' : 'all')); }
    function appendBatch() {
        const fragment = document.createDocumentFragment();
        for (const name of matches.slice(rendered, rendered + 32)) {
            const $cb = $('<input type="checkbox">').val(name).prop('checked', all || chosen.has(name));
            const $label = $('<label>').attr('title', name).append($cb);
            if (!gallery) $label.append($('<img alt="" loading="lazy" decoding="async" width="24" height="24">').attr('src', `/thumbnail?type=avatar&file=${encodeURIComponent(name)}`));
            fragment.append($label.append($('<span>').text(labels.get(name) || name))[0]);
            rendered++;
        }
        $rows.append(fragment);
    }
    function draw() {
        rendered = 0; $rows.empty().scrollTop(0); appendBatch();
    }
    $rows.on('scroll.bm', ({ currentTarget: el }) => {
        if (rendered < matches.length && el.scrollHeight - el.scrollTop - el.clientHeight < 88) appendBatch();
    });
    const $pickMatches = button(`${id}-matches`, 'pickMatches').hide();
    $search.on('input.bm', () => { const q = $search.val().trim().toLowerCase(); matches = q ? names.filter(name => q.startsWith('#') && !gallery ? tags.get(name)?.some(tag => tag.toLowerCase().includes(q.slice(1))) : `${name} ${labels.get(name) || ''}`.toLowerCase().includes(q)) : names; $pickMatches.toggle(!gallery && !!q && matches.length > 0); draw(); });
    $pickMatches.on('click.bm', () => { chosen = new Set(matches); all = chosen.size === names.length; save(all ? null : [...chosen]); $scope.empty(); syncToggle(); draw(); });
    $all.on('click.bm', () => {
        all = !all;
        save(all ? null : []); $scope.empty();
        chosen.clear(); syncToggle(); draw();
    });
    $choose.on('click.bm', async () => {
        if ($options.is(':visible')) {
            $options.hide(); $rows.empty(); names = []; matches = []; chosen.clear(); labels.clear(); tags.clear();
            $choose.attr('aria-expanded', 'false'); return;
        }
        if (!beginOperation(exportUi)) return;
        const job = operation;
        try {
            labels.clear(); tags.clear(); $pickMatches.hide();
            if (!gallery) for (const c of ctx.characters ?? []) { if (c?.avatar) { labels.set(c.avatar, c.name || c.avatar); tags.set(c.avatar, Array.isArray(c.tags) ? c.tags.filter(tag => typeof tag === 'string') : []); } }
            names = gallery ? await galleryFolders(false) : [...labels.keys()];
            $scope.text(chats ? preferences().singleChat?.file || '' : '');
            checkCancelled();
            const saved = selected();
            const savedNames = new Set(saved ?? []);
            chosen = new Set(names.filter(name => savedNames.has(name)));
            all = !Array.isArray(saved) || (names.length > 0 && chosen.size === names.length);
            matches = names.sort(); $search.val(''); syncToggle(); draw();
            $options.show(); $choose.attr('aria-expanded', 'true');
        } catch (error) { if (!job.controller.signal.aborted) exportUi.error(tr('failed', redact(error.message))); }
        finally { endOperation(job, exportUi); }
    });
    $rows.on('change.bm', 'input', event => {
        if (all) chosen = new Set(names);
        const { checked, value } = event.target;
        if (checked) chosen.add(value); else chosen.delete(value);
        all = chosen.size === names.length;
        save(all ? null : [...chosen]); $scope.empty();
        syncToggle();
    });
    const $toolbar = $('<div class="bm-folder-toolbar">').append($search, $all);
    $options.append($toolbar, $rows);
    if (!gallery) {
        const shortcut = (onlyChat) => button(`${id}-${onlyChat ? 'chat' : 'card'}`, onlyChat ? 'thisChat' : 'thisCard').on('click.bm', () => {
            const live = SillyTavern.getContext();
            const avatar = live.characters?.[live.characterId]?.avatar;
            const chat = onlyChat && live.getCurrentChatId?.();
            if (live.groupId != null && live.groupId !== '' || !avatar || !names.includes(avatar) || onlyChat && !chat) { exportUi.status(tr('openSolo')); return; }
            chosen = new Set([avatar]); all = false;
            const file = onlyChat ? `${String(chat).replace(/\.jsonl$/i, '')}.jsonl` : '';
            save([avatar], onlyChat ? {avatar, file} : null); $scope.text(file);
            $search.val(''); $pickMatches.hide(); matches = names; syncToggle(); draw();
        });
        $toolbar.append(shortcut(false).addClass('bm-picker-toggle'));
        const $quick = $('<div class="bm-quick">');
        if (chats) $quick.append(shortcut(true), $scope);
        $rows.before($quick.append($pickMatches));
    }
    return { $choose, $options };
}

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

    const persist = () => {
        const ids = getSelectedExportIds();
        savePreferences({ selectedCategories: ids });
        $('#bm-sel-toggle').text(tr(ids.length === REGISTRY.length ? 'none' : 'all'));
    };
    $('#bm-sel-toggle').text(tr(getSelectedExportIds().length === REGISTRY.length ? 'none' : 'all')).on('click.bm', () => {
        const checked = getSelectedExportIds().length !== REGISTRY.length;
        $('#bm-root .bm-catrow input').prop('checked', checked);
        persist();
    });
    $('.bm-catrow input', '#bm-root').on('change.bm', persist);
    $('#bm-refresh-counts').on('click.bm', refreshCounts);
    $('#bm-export-go').on('click.bm', async () => {
        const ids = getSelectedExportIds();
        if (!ids.length) { exportUi.error(tr('select')); return; }
        await runExport(ids, exportUi);
    });
    $('#bm-cancel-btn').on('click.bm', () => { operation?.controller.abort(); exportUi.status(tr('cancelling')); });
    renderLastDownload();
}

export function initialize() {
    if (enabled || document.getElementById('bm-root')) return;
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
