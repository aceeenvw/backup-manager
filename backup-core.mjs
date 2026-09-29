const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export const MAX_FILES = 10000;
export const MAX_METADATA = 8 * 1048576;

export function safeName(value) {
    let name = String(value ?? '').normalize('NFC').replace(/[\/\\?%*:|"<>\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    if (name.length > 120) name = Array.from(name.slice(0, name.length - ext.length)).slice(0, 120 - ext.length).join('') + ext;
    if (RESERVED.test(name)) name = '_' + name;
    return name && !/^_+$/.test(name) ? name : 'unnamed';
}

export function pathKey(path) {
    return path.normalize('NFC').toLowerCase();
}

export function validPath(path) {
    return typeof path === 'string' && path.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(path)
        && path.split('/').every(part => part && part !== '.' && part !== '..' && !/[?:*|"<>]/.test(part) && !/[. ]$/.test(part) && !RESERVED.test(part));
}

export function allocatePath(path, used) {
    if (!validPath(path)) throw new Error('Unsafe archive path');
    const slash = path.lastIndexOf('/');
    const folder = path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let result = path;
    for (let n = 2; used.has(pathKey(result)); n++) result = `${folder}${base} (${n})${ext}`;
    used.add(pathKey(result));
    return result;
}

const SENSITIVE_FIELDS = new Set([
    'reverse_proxy', 'proxy_password', 'custom_url', 'custom_include_body', 'custom_exclude_body',
    'custom_include_headers', 'vertexai_region', 'vertexai_express_project_id', 'azure_base_url',
    'azure_deployment_name', 'workers_ai_account_id',
]);

export function cleanPreset(preset) {
    const copy = structuredClone(preset);
    for (const key of SENSITIVE_FIELDS) delete copy[key];
    return copy;
}

export function dataSize(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
    if (data instanceof Blob) return data.size;
    return data.byteLength;
}

function assertFileParents(paths) {
    for (const path of paths) {
        const parts = path.split('/');
        parts.pop();
        while (parts.length) {
            if (paths.has(parts.join('/'))) throw new Error('Archive file conflicts with a directory');
            parts.pop();
        }
    }
}

export function validateManifest(manifest, maxBytes) {
    if (!manifest || ![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.perFile) || !manifest.perFile.length) throw new Error('Invalid or unsupported backup manifest');
    if (manifest.perFile.length > MAX_FILES) throw new Error('Too many archive files');
    const paths = new Set([pathKey('backup-manifest.json')]);
    let total = 0;
    for (const file of manifest.perFile) {
        if (!file || !validPath(file.path) || paths.has(pathKey(file.path))) throw new Error('Unsafe or duplicate manifest path');
        paths.add(pathKey(file.path));
        if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid declared file size');
        if (file.hash !== null && !/^[a-f0-9]{64}$/.test(file.hash ?? '')) throw new Error('Invalid file hash');
        total += file.size;
        if (total > maxBytes) throw new Error('Backup exceeds the size limit');
    }
    if (!Number.isSafeInteger(manifest.totalUncompressedSize) || total !== manifest.totalUncompressedSize) throw new Error('Manifest total does not match file sizes');
    assertFileParents(paths);
    return paths;
}

// Inspect central-directory metadata before allowing any ZIP decompression.
export async function inspectZip(file, maxBytes) {
    if (file.size > maxBytes || file.size < 22) throw new Error('ZIP is too large or invalid');
    const tailOffset = Math.max(0, file.size - 65557);
    const tail = new DataView(await file.slice(tailOffset).arrayBuffer());
    let end = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
        if (tail.getUint32(i, true) === 0x06054b50 && i + 22 + tail.getUint16(i + 20, true) === tail.byteLength) { end = i; break; }
    }
    if (end < 0) throw new Error('Invalid ZIP directory');
    const count = tail.getUint16(end + 10, true);
    const length = tail.getUint32(end + 12, true);
    const offset = tail.getUint32(end + 16, true);
    if (tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true) || tail.getUint16(end + 8, true) !== count
        || count === 65535 || count > MAX_FILES + 1 || length > MAX_METADATA || offset + length !== tailOffset + end) throw new Error('Unsupported ZIP layout or excessive directory');
    const directory = new DataView(await file.slice(offset, offset + length).arrayBuffer());
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const paths = new Set();
    const entries = new Map();
    let pos = 0, total = 0;
    for (let i = 0; i < count; i++) {
        if (pos + 46 > length || directory.getUint32(pos, true) !== 0x02014b50) throw new Error('Invalid ZIP entry');
        const flags = directory.getUint16(pos + 8, true);
        const method = directory.getUint16(pos + 10, true);
        const size = directory.getUint32(pos + 24, true);
        const compressed = directory.getUint32(pos + 20, true);
        const nameLength = directory.getUint16(pos + 28, true);
        const extraLength = directory.getUint16(pos + 30, true);
        const commentLength = directory.getUint16(pos + 32, true);
        const next = pos + 46 + nameLength + extraLength + commentLength;
        const fileType = (directory.getUint32(pos + 38, true) >>> 16) & 0xf000;
        if (next > length || flags & 1 || fileType === 0xa000 || ![0, 8].includes(method) || size === 0xffffffff || compressed === 0xffffffff
            || directory.getUint16(pos + 34, true) || directory.getUint32(pos + 42, true) >= offset) throw new Error('Unsupported ZIP entry');
        const name = decoder.decode(new Uint8Array(directory.buffer, pos + 46, nameLength));
        for (let extra = pos + 46 + nameLength; extra < next - commentLength;) {
            if (extra + 4 > next - commentLength) throw new Error('Invalid ZIP extra field');
            const tag = directory.getUint16(extra, true), size = directory.getUint16(extra + 2, true);
            const end = extra + 4 + size;
            if (end > next - commentLength) throw new Error('Invalid ZIP extra field');
            if (tag === 0x7075 && (size < 5 || directory.getUint8(extra + 4) !== 1 || decoder.decode(new Uint8Array(directory.buffer, extra + 9, size - 5)) !== name)) throw new Error('ZIP path encoding mismatch');
            extra = end;
        }
        const isFolder = name.endsWith('/');
        const path = isFolder ? name.slice(0, -1) : name;
        const key = pathKey(path);
        if (!validPath(path) || paths.has(key)) throw new Error('Unsafe or duplicate ZIP path');
        paths.add(key);
        total += size;
        if (total > maxBytes || (isFolder && size !== 0)) throw new Error('ZIP exceeds decompression limit');
        if (!isFolder) entries.set(name, size);
        pos = next;
    }
    if (pos !== length) throw new Error('Invalid ZIP directory length');
    if (!entries.has('backup-manifest.json') || entries.get('backup-manifest.json') > MAX_METADATA) throw new Error('Missing or oversized manifest');
    assertFileParents(new Set([...entries.keys()].map(pathKey)));
    return entries;
}

export function readZipEntry(entry, maxBytes, signal) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0, settled = false;
        const stream = entry.internalStream('uint8array');
        const fail = error => {
            if (settled) return;
            settled = true;
            stream.pause();
            signal?.removeEventListener('abort', abort);
            chunks.length = 0;
            reject(error);
        };
        const abort = () => fail(new DOMException('Cancelled', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        stream.on('data', chunk => {
            size += chunk.byteLength;
            if (size > maxBytes) { fail(new Error('Decompressed file exceeds limit')); return; }
            if (!settled) chunks.push(chunk);
        });
        stream.on('error', fail);
        stream.on('end', () => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            const result = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
            chunks.length = 0;
            resolve(result);
        });
        if (signal?.aborted) abort(); else stream.resume();
    });
}
