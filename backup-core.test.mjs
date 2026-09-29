import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as core from './backup-core.mjs';
import { translate } from './locales.mjs';

const zipSource = await readFile(process.env.SILLYTAVERN_PATH ? `${process.env.SILLYTAVERN_PATH}/public/lib/jszip.min.js` : new URL('../../../../SillyTavern/public/lib/jszip.min.js', import.meta.url), 'utf8');
const zipModule = { exports: {} };
vm.runInNewContext(zipSource, { module: zipModule, exports: zipModule.exports, setImmediate, setTimeout, clearTimeout, Promise, Uint8Array, ArrayBuffer, Blob, Buffer });
const JSZip = zipModule.exports;
const moduleSource = await readFile(new URL('./index.js', import.meta.url), 'utf8');
const importedCore = Object.fromEntries(moduleSource.match(/^import \{ (.*?) \} from '\.\/backup-core\.mjs';/m)[1].split(', ').map(name => [name, core[name]]));
const source = moduleSource.replace(/^import .*;\n/gm, '').replace(/^export /gm, '').replace(/^initialize\(\);$/m, '');

function harness() {
    const context = { characters: [], powerUserSettings: {}, extensionSettings: {}, getRequestHeaders: () => ({}), saveSettingsDebounced() {} };
    const notices = [], downloads = [], reports = [];
    const $ = () => ({ val: () => 256, text() { return this; }, prop() { return this; }, attr() { return this; }, css() { return this; }, show() {}, hide() {}, addClass() {}, removeClass() {}, empty() { return this; }, append() { return this; }, find() { return this; } });
    class Zip {
        file() { return this; }
        async generateAsync(options, progress) { progress({ percent: 100 }); return new Blob(['zip']); }
    }
    const ui = { locked: false, lock() { this.locked = true; }, unlock() { this.locked = false; }, status: value => notices.push(value), progress() {}, error: value => notices.push(value), warn: value => notices.push(value), success: value => notices.push(value), report: value => reports.push(value) };
    const sandbox = vm.createContext({ ...importedCore, translate, getCurrentLocale: () => 'en', SillyTavern: { getContext: () => context }, $, window: { JSZip: Zip }, JSZip: Zip, Blob, TextEncoder, TextDecoder, URL, AbortController, DOMException, crypto: globalThis.crypto, structuredClone, btoa, atob, setTimeout, clearTimeout, console: { warn() {} }, notices, downloads, ui, fetch: async () => new Response(JSON.stringify({ pkgVersion: '1.19.0' })), Response });
    vm.runInContext(source, sandbox);
    vm.runInContext('downloadBlob = (blob, name) => downloads.push(name); renderLastDownload = () => {};', sandbox);
    return { sandbox, context, ui, downloads, notices, reports, run: code => vm.runInContext(code, sandbox) };
}

test('preset cleanup does not mutate source and strips native sensitive fields', () => {
    const preset = { proxy_password: 'fake-password', custom_include_headers: 'Authorization: fake', reverse_proxy: 'https://example.test', temperature: 0.8, prompts: [{ content: 'keep me' }] };
    const clean = core.cleanPreset(preset);
    assert.equal(clean.proxy_password, undefined);
    assert.equal(clean.custom_include_headers, undefined);
    assert.equal(clean.reverse_proxy, undefined);
    assert.equal(preset.proxy_password, 'fake-password');
    assert.deepEqual(clean.prompts, preset.prompts);
});

test('path allocation distinguishes sanitized folders and preserves extensions', () => {
    const used = new Set();
    assert.equal(core.allocatePath(`chats/${core.safeName('foo%bar')}`, used), 'chats/foo_bar');
    assert.equal(core.allocatePath(`chats/${core.safeName('foo_bar')}`, used), 'chats/foo_bar (2)');
    assert.equal(core.allocatePath('chats/FOO_BAR', used), 'chats/FOO_BAR (3)');
    assert.ok(core.safeName('x'.repeat(200) + '.jsonl').endsWith('.jsonl'));
    for (const path of ['../x', '/x', 'x/../y', 'x\\y', 'C:/x', 'x/con.png']) assert.equal(core.validPath(path), false);
});

test('manifest rejects empty, duplicated, malformed and oversized declarations; accepts legacy missing hashes as unverified', () => {
    const manifest = { schemaVersion: 1, totalUncompressedSize: 3, perFile: [{ path: 'x.txt', size: 3, hash: null }] };
    assert.equal(core.validateManifest(manifest, 100).size, 2);
    for (const value of [{}, null, { ...manifest, schemaVersion: 999 }, { ...manifest, totalUncompressedSize: 4 }, { ...manifest, perFile: [...manifest.perFile, ...manifest.perFile] }, { ...manifest, perFile: [{ path: '../x', size: 3, hash: null }] }, { ...manifest, perFile: [{ path: 'x', size: 3, hash: 'bad' }] }]) assert.throws(() => core.validateManifest(value, 100));
    assert.throws(() => core.validateManifest(manifest, 2));
    assert.throws(() => core.validateManifest({ schemaVersion: 2, totalUncompressedSize: 2, perFile: [{ path: 'x', size: 1, hash: null }, { path: 'x/y', size: 1, hash: null }] }, 100), /conflicts/);
});

test('real bundled JSZip archives pass preflight; traversal and oversized entries fail', async () => {
    const make = async (path, data) => {
        const zip = new JSZip();
        zip.file('backup-manifest.json', '{}');
        zip.file(path, data, { createFolders: false });
        return new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })]);
    };
    const entries = await core.inspectZip(await make('chats/x.jsonl', 'hello'), 10000);
    assert.equal(entries.get('chats/x.jsonl'), 5);
    await assert.rejects(core.inspectZip(await make('../escape', 'x'), 10000), /Unsafe/);
    await assert.rejects(core.inspectZip(await make('large.txt', 'x'.repeat(20000)), 10000), /limit/);
    const link = new JSZip();
    link.file('backup-manifest.json', '{}');
    link.file('link', 'target', { unixPermissions: 0xa1ff });
    await assert.rejects(core.inspectZip(new Blob([await link.generateAsync({ type: 'uint8array', platform: 'UNIX' })]), 10000), /Unsupported/);
});

test('decompression reader enforces actual output size and cancellation', async () => {
    const zip = new JSZip();
    zip.file('x', 'a'.repeat(100000));
    await assert.rejects(core.readZipEntry(zip.file('x'), 10), /limit/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(core.readZipEntry(zip.file('x'), 100000, controller.signal), { name: 'AbortError' });
    assert.equal((await core.readZipEntry(zip.file('x'), 100000)).byteLength, 100000);
});

test('export cancellation during manifest hashing prevents download and unlocks UI', async () => {
    const app = harness();
    app.run("REGISTRY.splice(0, REGISTRY.length, { id: 'test', exportFn: async () => ({ files: [{ path: 'test.txt', data: 'test' }], warnings: [] }) }); sha256 = async () => { operation.controller.abort(); return 'a'.repeat(64); };");
    await app.run("runExport(['test'], ui)");
    assert.equal(app.downloads.length, 0);
    assert.equal(app.ui.locked, false);
});

test('packing errors unlock UI; concurrent export attempts do not duplicate downloads', async () => {
    const app = harness();
    app.run("REGISTRY.splice(0, REGISTRY.length, { id: 'test', exportFn: async () => ({ files: [{ path: 'test.txt', data: 'test' }], warnings: [] }) }); JSZip.prototype.generateAsync = async () => { throw new Error('packing failure'); };");
    await app.run("runExport(['test'], ui)");
    assert.equal(app.ui.locked, false);
    assert.equal(app.downloads.length, 0);
    assert.ok(app.notices.some(value => value.includes('packing failure')));
    app.run("JSZip.prototype.generateAsync = async () => new Blob(['zip']);");
    await app.run("Promise.all([runExport(['test'], ui), runExport(['test'], ui)])");
    assert.equal(app.downloads.length, 1);
});

test('persona metadata uses live native format and retains default selection', async () => {
    const app = harness();
    app.context.powerUserSettings = { personas: { 'me.png': 'Me' }, persona_descriptions: { 'me.png': { description: 'latest unsaved edit' } }, default_persona: 'me.png' };
    const result = await app.run('exportPersonas()');
    const bundle = JSON.parse(result.files[0].data);
    assert.equal(bundle.default_persona, 'me.png');
    assert.equal(bundle.persona_descriptions['me.png'].description, 'latest unsaved edit');
    assert.equal(bundle.defaultPersona, undefined);
});

test('solo chat counts total files, not characters, and do not read chat content', async () => {
    const app = harness();
    app.context.characters.push({ avatar: 'one.png' }, { avatar: 'two.png' }, { avatar: 'empty.png' }, { avatar: 'missing.png' }, { name: 'No avatar' });
    app.run("const countRequests = []; postJson = async (url, body) => { countRequests.push({ url, body }); if (body.avatar_url === 'missing.png') return { error: true }; const count = body.avatar_url === 'one.png' ? 3 : body.avatar_url === 'two.png' ? 2 : 0; return Array.from({ length: count }, (_, i) => ({ file_name: `${i}.jsonl` })); };");
    assert.equal((await app.run('listChats()')).count, 5);
    assert.equal(app.run('countRequests.length'), 4);
    assert.equal(app.run("countRequests.every(({ url, body }) => url === '/api/characters/chats' && body.simple === true)"), true);
    assert.equal(app.run("REGISTRY.find(cat => cat.id === 'chats').unit"), 'chatsUnit');
    assert.equal(translate('en', 'chatsUnit', 5), '5 chats');
    assert.equal(translate('ru', 'chatsUnit', 5), '5 чатов');

    app.run("postJson = async () => { throw new Error('listing failed'); };");
    await assert.rejects(app.run('listChats()'), /listing failed/);
    app.run('postJson = async () => [{ invalid: true }];');
    await assert.rejects(app.run('listChats()'), /Invalid character chat listing/);
    app.run('beginOperation(ui); let scanned = 0; postJson = async () => { scanned++; operation.controller.abort(); return [{ file_name: "first.jsonl" }]; };');
    await assert.rejects(app.run('listChats()'), { name: 'AbortError' });
    assert.equal(app.run('scanned'), 1);
});

test('solo chat export retains raw JSONL and separates colliding avatar folders', async () => {
    const app = harness();
    app.context.characters.push({ avatar: 'foo%bar.png', name: 'One' }, { avatar: 'foo_bar.png', name: 'Two' });
    app.run("beginOperation(ui); postJson = async (url, body) => url === '/api/characters/chats' ? [{ file_name: 'same.jsonl' }] : { result: 'invalid-but-preserved\\r\\n{\"mes\":\"hello\"}\\n' };");
    const result = await app.run('exportChats()');
    const chats = result.files.filter(file => file.path.endsWith('.jsonl'));
    assert.equal(chats.length, 2);
    assert.notEqual(chats[0].path, chats[1].path);
    assert.equal(chats[0].data, 'invalid-but-preserved\r\n{"mes":"hello"}\n');
    assert.equal(chats[0].source.avatar, 'foo%bar.png');
    const mappings = result.files.filter(file => file.path.endsWith('_mapping.json'));
    assert.equal(JSON.parse(mappings[1].data).files[0].path, chats[1].path);
});

test('cached extension manifests preserve canonical IDs and strip URL credentials', async () => {
    const app = harness();
    app.context.getExtensionManifest = () => ({ homePage: 'https://user:password@example.test/repo?token=fake#hash', version: '2.0' });
    app.run("request = async () => [{ name: 'third-party/my-extension', type: 'local' }];");
    const result = await app.run('exportExtensionList()');
    const entry = JSON.parse(result.files[0].data).extensions[0];
    assert.equal(entry.name, 'third-party/my-extension');
    assert.equal(entry.homePage, 'https://example.test/repo');
    assert.equal(entry.version, '2.0');
});

test('selection preferences preserve an empty selection and account-specific settings', () => {
    const app = harness();
    app.run("savePreferences({ selectedCategories: [], maxMiB: 64 });");
    assert.deepEqual(Array.from(app.context.extensionSettings.backup_manager.selectedCategories), []);
    assert.equal(app.context.extensionSettings.backup_manager.maxMiB, 64);
    const otherAccount = {};
    app.context.extensionSettings = otherAccount;
    assert.equal(app.run('preferences().lastDownloadISO'), undefined);
});

test('English and Russian UI strings fall back to English for other languages', () => {
    assert.equal(translate('ru-ru', 'export'), 'Создать ZIP');
    assert.equal(translate('fr', 'export'), 'Create backup ZIP');
});

test('coverage distinguishes partial, empty, failed, skipped and unselected categories', async () => {
    const app = harness();
    const report = app.run("coverageReport(['characters', 'chats', 'worlds', 'themes', 'presets'], [{ id: 'characters', status: 'partial', files: 1, bytes: 8, warnings: ['card failed'] }, { id: 'chats', status: 'empty', files: 0, bytes: 0, warnings: [] }, { id: 'worlds', status: 'failed', files: 0, bytes: 0, warnings: ['request failed'] }], ['card failed', 'request failed'], true)");
    assert.equal(report.files, 1);
    assert.equal(report.bytes, 8);
    assert.equal(report.categories.find(cat => cat.id === 'characters').status, 'partial');
    assert.equal(report.categories.find(cat => cat.id === 'themes').status, 'skipped');
    assert.equal(report.categories.find(cat => cat.id === 'backgrounds').status, 'notSelected');
    assert.ok(report.categories.find(cat => cat.id === 'chats').limitations.en.includes('attachments'));
});

test('verification rejects empty manifests, mismatches and unexpected files; missing hashes remain unverified', async () => {
    for (const variant of ['valid', 'validUnicode', 'empty', 'badHash', 'extra', 'missing', 'noHash', 'unicodeOverride']) {
        const app = harness();
        const zip = new JSZip();
        const text = 'hello';
        const path = variant === 'validUnicode' ? 'папка/пример.json' : 'x.txt';
        const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
        const manifest = variant === 'empty' ? {} : { schemaVersion: 1, totalUncompressedSize: 5, perFile: [{ path, size: 5, hash: variant === 'noHash' ? null : variant === 'badHash' ? 'a'.repeat(64) : hash }] };
        zip.file('backup-manifest.json', JSON.stringify(manifest));
        if (variant !== 'missing') zip.file(variant === 'unicodeOverride' ? '../é.txt' : path, text, { createFolders: variant === 'validUnicode' });
        if (variant === 'extra') zip.file('extra.txt', 'extra');
        const blob = new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', ...(variant === 'unicodeOverride' ? { encodeFileName: name => new TextEncoder().encode(name === '../é.txt' ? 'x.txt' : name) } : {}) })]);
        const input = { files: [blob], click() { this.promise = this.onchange(); } };
        app.sandbox.document = { createElement: () => input };
        app.sandbox.JSZip = app.sandbox.window.JSZip = { loadAsync: async file => JSZip.loadAsync(new Uint8Array(await file.arrayBuffer())) };
        app.sandbox.ui = app.ui;
        app.run('Object.assign(exportUi, ui); verifyBackup();');
        await input.promise;
        const final = app.notices.at(-1);
        assert.ok(final.includes(variant.startsWith('valid') ? 'Integrity verified' : variant === 'noHash' ? 'Unverified' : variant === 'empty' ? 'Invalid or unsupported' : variant === 'unicodeOverride' ? 'ZIP path encoding mismatch' : 'Integrity problems'), `${variant}: ${final}`);
        assert.equal(app.ui.locked, false);
    }
});

test('groups preserve definitions, shared chat identities and failed references without filename collisions', async () => {
    const app = harness();
    const calls = [];
    app.sandbox.calls = calls;
    app.run(`beginOperation(ui); postJson = async (url, body) => {
        if (url === '/api/groups/all') return [
            { id: 'g%1', members: ['foo.png'], chats: ['a%b', 'shared', 'missing'], chat_id: 'a%b', date_added: 123, chat_size: 999, custom: { keep: true } },
            { id: 'g_1', members: ['bar.png'], chats: ['a_b', 'shared'], chat_id: 'shared' },
            { id: '_mapping', members: [], chats: [], chat_id: null }
        ];
        calls.push(body);
        if (body.file === 'missing.jsonl') throw new Error('missing file');
        return { result: 'raw\\r\\n' + body.file };
    };`);
    const result = await app.run('exportGroups()');
    const definitions = result.files.filter(file => file.source?.groupId);
    assert.equal(definitions.length, 3);
    assert.notEqual(definitions[0].path, definitions[1].path);
    const definition = JSON.parse(definitions[0].data);
    assert.equal(definition.id, 'g%1');
    assert.equal(definition.date_added, undefined);
    assert.equal(definition.custom.keep, true);
    const mapping = JSON.parse(result.files.find(file => file.path === 'groups/_mapping.json').data).groups;
    assert.equal(mapping[0].members[0], 'foo.png');
    assert.notEqual(mapping[0].chats[0].path, mapping[1].chats[0].path);
    assert.equal(mapping[0].chats[1].path, mapping[1].chats[1].path);
    assert.equal(mapping[0].chats[2].path, null);
    assert.equal(calls.filter(call => call.file === 'shared.jsonl').length, 1);
    assert.ok(calls.every(call => call.is_group && call.format === 'jsonl'));
    assert.equal(result.warnings.length, 1);
});

test('budget overflow stops export; completed handoff alone updates its timestamp and compression policy', async () => {
    const app = harness();
    const packed = [];
    app.sandbox.packed = packed;
    app.run(`REGISTRY.splice(0, REGISTRY.length, { id: 'test', exportFn: async () => {
        operation.maxBytes = 10;
        const files = []; addFile(files, 'large.txt', 'x'.repeat(11)); return { files };
    } });`);
    await app.run("runExport(['test'], ui)");
    assert.equal(app.downloads.length, 0);
    assert.equal(app.ui.locked, false);
    assert.equal(app.context.extensionSettings.backup_manager?.lastDownloadISO, undefined);
    app.run(`REGISTRY[0].exportFn = async () => {
        const files = []; addFile(files, 'card.png', 'image'); addFile(files, 'data.json', '{}');
        return { files, warnings: [] };
    }; JSZip.prototype.file = (path, data, options) => { packed.push({ path, data, options }); };`);
    await app.run("runExport(['test'], ui)");
    assert.equal(app.downloads.length, 1);
    assert.ok(app.context.extensionSettings.backup_manager.lastDownloadISO);
    assert.equal(packed.find(file => file.path === 'card.png').options.compression, 'STORE');
    assert.equal(packed.find(file => file.path === 'data.json').options.compression, 'DEFLATE');
    const manifest = JSON.parse(packed.find(file => file.path === 'backup-manifest.json').data);
    assert.equal(manifest.stVersion, '1.19.0');
    assert.ok(manifest.perFile.some(file => file.path === 'backup-report.json'));
    assert.equal(manifest.totalUncompressedSize, packed.filter(file => file.path !== 'backup-manifest.json').reduce((size, file) => size + core.dataSize(file.data), 0));
});

test('cancellation while packing discards the ZIP and does not record a download', async () => {
    const app = harness();
    app.run(`REGISTRY.splice(0, REGISTRY.length, { id: 'test', exportFn: async () => ({ files: [{ path: 'x', data: 'x' }], warnings: [] }) });
        JSZip.prototype.generateAsync = async () => { operation.controller.abort(); return new Blob(['zip']); };`);
    await app.run("runExport(['test'], ui)");
    assert.equal(app.downloads.length, 0);
    assert.equal(app.context.extensionSettings.backup_manager?.lastDownloadISO, undefined);
    assert.equal(app.ui.locked, false);
});

test('requests cancel in-flight reads and bound declared metadata before parsing', async () => {
    const app = harness();
    app.sandbox.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError'))));
    const pending = app.run("beginOperation(ui); request('/api/test');");
    app.run('operation.controller.abort();');
    await assert.rejects(pending, { name: 'AbortError' });
    app.run('operation = null;');
    app.sandbox.fetch = async () => new Response('{}', { headers: { 'content-length': String(core.MAX_METADATA + 1) } });
    await assert.rejects(app.run("request('/api/test')"), /8 MiB limit/);
});

test('a stale file-picker callback cannot start verification after lifecycle cleanup', async () => {
    const app = harness();
    const input = { files: [new Blob(['not a zip'])], click() {} };
    app.sandbox.document = { createElement: () => input };
    app.run('verifyBackup(); lifecycle++;');
    await input.onchange();
    assert.equal(app.run('operation'), null);
    assert.equal(app.notices.length, 0);
});

test('a native persona export packs and verifies end-to-end with bundled JSZip', async () => {
    const app = harness();
    app.context.powerUserSettings = { personas: { 'я.png': 'Me' }, persona_descriptions: { 'я.png': { description: 'Описание' } }, default_persona: 'я.png' };
    app.sandbox.JSZip = app.sandbox.window.JSZip = JSZip;
    app.run('downloadBlob = blob => downloads.push(blob);');
    await app.run("runExport(['personas'], ui)");
    assert.equal(app.downloads.length, 1, app.notices.join('\n'));
    const file = app.downloads[0];
    const entries = await core.inspectZip(file, 1000000);
    assert.equal(entries.size, 3);
    const zip = await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()));
    const metadata = JSON.parse(await zip.file('personas/personas.json').async('string'));
    assert.equal(metadata.default_persona, 'я.png');
    assert.equal(metadata.persona_descriptions['я.png'].description, 'Описание');
    const input = { files: [file], click() { this.promise = this.onchange(); } };
    app.sandbox.document = { createElement: () => input };
    app.sandbox.JSZip = { loadAsync: async blob => JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer())) };
    app.run('Object.assign(exportUi, ui); verifyBackup();');
    await input.promise;
    assert.ok(app.notices.at(-1).startsWith('Integrity verified: 2 files'), app.notices.at(-1));
});
