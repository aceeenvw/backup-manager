const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
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
