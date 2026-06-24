import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';

const MOCK_FS_ROUTE = '/__mock-fs/';
const PROJECT_DIRECTORY = '.vloproject';

interface StoredFile {
    body: Buffer;
    contentType: string;
}

interface MockFileSystemOptions {
    rootName?: string;
    projectFormat?: 'current' | 'legacy';
}

function normalizePath(value: string): string {
    const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
    if (normalized === '.') return '';
    if (
        normalized.startsWith('/') ||
        normalized === '..' ||
        normalized.startsWith('../')
    ) {
        throw new Error(`Unsafe mock filesystem path: ${value}`);
    }
    return normalized;
}

function parentPath(value: string): string {
    const parent = path.posix.dirname(value);
    return parent === '.' ? '' : parent;
}

function detectContentType(filePath: string, body: Buffer): string {
    const extension = path.posix.extname(filePath).toLowerCase();
    const extensionTypes: Record<string, string> = {
        '.gif': 'image/gif',
        '.jpeg': 'image/jpeg',
        '.jpg': 'image/jpeg',
        '.json': 'application/json',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.png': 'image/png',
        '.wav': 'audio/wav',
        '.webm': 'video/webm',
        '.webp': 'image/webp',
    };
    const extensionType = extensionTypes[extension];
    if (extensionType) return extensionType;

    if (body.length >= 12 && body.subarray(4, 8).toString('ascii') === 'ftyp') {
        return 'video/mp4';
    }
    if (
        body.length >= 8 &&
        body.subarray(0, 8).equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
    ) {
        return 'image/png';
    }
    if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
        return 'image/jpeg';
    }
    if (body.length >= 4 && body.subarray(0, 4).toString('ascii') === 'RIFF') {
        return 'audio/wav';
    }
    if (body.length >= 3 && body.subarray(0, 3).toString('ascii') === 'ID3') {
        return 'audio/mpeg';
    }

    return 'application/octet-stream';
}

function createCurrentProjectDocuments(legacyProject: Record<string, unknown>) {
    const now = Date.now();
    const id =
        typeof legacyProject.id === 'string'
            ? legacyProject.id
            : 'e2e-current-project';
    const title =
        typeof legacyProject.title === 'string'
            ? legacyProject.title
            : 'E2E Project';
    const createdAt =
        typeof legacyProject.created_at === 'number'
            ? legacyProject.created_at
            : now;
    const config =
        legacyProject.config && typeof legacyProject.config === 'object'
            ? legacyProject.config
            : {};
    const timeline =
        legacyProject.timeline && typeof legacyProject.timeline === 'object'
            ? (legacyProject.timeline as {
                tracks?: unknown[];
                clips?: unknown[];
            })
            : {};
    const assets =
        legacyProject.assets && typeof legacyProject.assets === 'object'
            ? legacyProject.assets
            : {};
    const assetFamilies =
        legacyProject.assetFamilies && typeof legacyProject.assetFamilies === 'object'
            ? legacyProject.assetFamilies
            : {};
    const tracks =
        Array.isArray(timeline.tracks) && timeline.tracks.length > 0
            ? timeline.tracks
            : [
                {
                    id: 'track_e2e_default',
                    type: 'visual',
                    label: 'Track 1',
                    isVisible: true,
                    isMuted: false,
                    isLocked: false,
                },
            ];

    return {
        manifest: {
            documentType: 'vlo.project',
            schemaVersion: 3,
            id,
            title,
            created_at: createdAt,
            last_modified: now,
            createdWithVloVersion: '0.2.0-e2e',
            lastSavedWithVloVersion: '0.2.0-e2e',
            config,
            files: {
                timeline: 'timeline.json',
                assets: 'assets.json',
                composites: 'composites.json',
                assetMetadataDir: 'asset-metadata',
            },
        },
        timeline: {
            documentType: 'vlo.timeline',
            schemaVersion: 3,
            updated_at: now,
            tracks,
            clips: timeline.clips ?? [],
        },
        assets: {
            documentType: 'vlo.assets',
            schemaVersion: 1,
            updated_at: now,
            assets,
            assetFamilies,
        },
        composites: {
            documentType: 'vlo.composites',
            schemaVersion: 1,
            updated_at: now,
            composites: {},
        },
    };
}

export class MockFileSystem {
    readonly rootName: string;
    private readonly directories = new Set<string>(['']);
    private readonly files = new Map<string, StoredFile>();

    constructor(
        fixtureRoot: string,
        options: MockFileSystemOptions = {},
    ) {
        this.rootName = options.rootName ?? 'Untitled_Project';
        this.seedDirectory(fixtureRoot);

        if ((options.projectFormat ?? 'current') === 'current') {
            this.convertLegacySeedToCurrentProject();
        }
    }

    private seedDirectory(directoryPath: string, mountPath = '') {
        this.directories.add(normalizePath(mountPath));

        for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
            const diskPath = path.join(directoryPath, entry.name);
            const virtualPath = normalizePath(
                mountPath ? `${mountPath}/${entry.name}` : entry.name,
            );

            if (entry.isDirectory()) {
                this.seedDirectory(diskPath, virtualPath);
                continue;
            }
            if (!entry.isFile()) continue;

            const body = fs.readFileSync(diskPath);
            this.files.set(virtualPath, {
                body,
                contentType: detectContentType(virtualPath, body),
            });
        }
    }

    private convertLegacySeedToCurrentProject() {
        const legacyPath = `${PROJECT_DIRECTORY}/project.json`;
        const legacyFile = this.files.get(legacyPath);
        if (!legacyFile) {
            throw new Error(`Fixture is missing ${legacyPath}`);
        }

        const parsed = JSON.parse(legacyFile.body.toString('utf8')) as Record<
            string,
            unknown
        >;
        if (parsed.documentType === 'vlo.project' && parsed.schemaVersion === 3) {
            return;
        }

        const documents = createCurrentProjectDocuments(parsed);
        this.writeJson(`${PROJECT_DIRECTORY}/project.json`, documents.manifest);
        this.writeJson(`${PROJECT_DIRECTORY}/timeline.json`, documents.timeline);
        this.writeJson(`${PROJECT_DIRECTORY}/assets.json`, documents.assets);
        this.writeJson(`${PROJECT_DIRECTORY}/composites.json`, documents.composites);
        this.directories.add(`${PROJECT_DIRECTORY}/asset-metadata`);
    }

    private writeJson(filePath: string, value: unknown) {
        const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
        this.files.set(normalizePath(filePath), {
            body,
            contentType: 'application/json',
        });
    }

    private ensureParentDirectories(filePath: string) {
        let current = parentPath(filePath);
        const missing: string[] = [];
        while (current && !this.directories.has(current)) {
            missing.push(current);
            current = parentPath(current);
        }
        for (const directory of missing.reverse()) {
            this.directories.add(directory);
        }
    }

    private listEntries(directoryPath: string) {
        const entries = new Map<string, 'file' | 'directory'>();

        for (const candidate of this.directories) {
            if (!candidate || parentPath(candidate) !== directoryPath) continue;
            entries.set(path.posix.basename(candidate), 'directory');
        }
        for (const candidate of this.files.keys()) {
            if (parentPath(candidate) !== directoryPath) continue;
            entries.set(path.posix.basename(candidate), 'file');
        }

        return [...entries.entries()]
            .map(([name, kind]) => ({ name, kind }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    private async handleRoute(route: Route) {
        const request = route.request();
        const url = new URL(request.url());
        const relativePath = normalizePath(
            decodeURIComponent(url.pathname.replace(MOCK_FS_ROUTE, '')),
        );
        const method = request.method();

        if (method === 'POST') {
            const kind = url.searchParams.get('kind');
            const create = url.searchParams.get('create') === 'true';
            if (kind === 'directory') {
                if (this.files.has(relativePath)) {
                    await route.fulfill({ status: 409, body: 'Path is a file' });
                    return;
                }
                if (!this.directories.has(relativePath)) {
                    if (!create) {
                        await route.fulfill({ status: 404, body: 'Directory not found' });
                        return;
                    }
                    this.ensureParentDirectories(`${relativePath}/placeholder`);
                    this.directories.add(relativePath);
                }
                await route.fulfill({ status: 204 });
                return;
            }

            if (kind === 'file') {
                if (this.directories.has(relativePath)) {
                    await route.fulfill({ status: 409, body: 'Path is a directory' });
                    return;
                }
                if (!this.files.has(relativePath)) {
                    if (!create) {
                        await route.fulfill({ status: 404, body: 'File not found' });
                        return;
                    }
                    this.ensureParentDirectories(relativePath);
                    this.files.set(relativePath, {
                        body: Buffer.alloc(0),
                        contentType: 'application/octet-stream',
                    });
                }
                await route.fulfill({ status: 204 });
                return;
            }
        }

        if (method === 'PUT') {
            this.ensureParentDirectories(relativePath);
            const body = request.postDataBuffer() ?? Buffer.alloc(0);
            this.files.set(relativePath, {
                body,
                contentType:
                    request.headerValue('content-type') ??
                    detectContentType(relativePath, body),
            });
            await route.fulfill({ status: 204 });
            return;
        }

        if (method === 'DELETE') {
            const recursive = url.searchParams.get('recursive') === 'true';
            if (this.files.delete(relativePath)) {
                await route.fulfill({ status: 204 });
                return;
            }
            if (!this.directories.has(relativePath)) {
                // FileSystemService deletion is intentionally idempotent.
                await route.fulfill({ status: 204 });
                return;
            }

            const prefix = relativePath ? `${relativePath}/` : '';
            const hasChildren =
                [...this.files.keys()].some((candidate) => candidate.startsWith(prefix)) ||
                [...this.directories].some(
                    (candidate) => candidate !== relativePath && candidate.startsWith(prefix),
                );
            if (hasChildren && !recursive) {
                await route.fulfill({ status: 409, body: 'Directory is not empty' });
                return;
            }

            for (const candidate of [...this.files.keys()]) {
                if (candidate.startsWith(prefix)) this.files.delete(candidate);
            }
            for (const candidate of [...this.directories]) {
                if (candidate === relativePath || candidate.startsWith(prefix)) {
                    this.directories.delete(candidate);
                }
            }
            await route.fulfill({ status: 204 });
            return;
        }

        if (url.searchParams.get('dir') === 'true') {
            if (!this.directories.has(relativePath)) {
                await route.fulfill({ status: 404, body: 'Directory not found' });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(this.listEntries(relativePath)),
            });
            return;
        }

        const file = this.files.get(relativePath);
        if (!file) {
            await route.fulfill({ status: 404, body: 'File not found' });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: file.contentType,
            body: file.body,
        });
    }

    async install(page: Page) {
        await page.route(`${MOCK_FS_ROUTE}**`, (route) => this.handleRoute(route));
        await installMockFileSystem(page, this.rootName);
    }

    exists(filePath: string): boolean {
        const normalized = normalizePath(filePath);
        return this.files.has(normalized) || this.directories.has(normalized);
    }

    readBuffer(filePath: string): Buffer {
        const normalized = normalizePath(filePath);
        const file = this.files.get(normalized);
        if (!file) throw new Error(`Mock file not found: ${normalized}`);
        return Buffer.from(file.body);
    }

    readText(filePath: string): string {
        return this.readBuffer(filePath).toString('utf8');
    }

    readJson<T>(filePath: string): T {
        return JSON.parse(this.readText(filePath)) as T;
    }

    list(filePath = ''): string[] {
        return this.listEntries(normalizePath(filePath)).map((entry) => entry.name);
    }
}

/**
 * Installs browser-side File System Access API handles backed by the route-level
 * in-memory filesystem owned by {@link MockFileSystem}.
 */
export async function installMockFileSystem(
    page: Page,
    rootName = 'Untitled_Project',
) {
    await page.addInitScript(
        ({ mockRoute, pickerRootName }) => {
            type EntryKind = 'file' | 'directory';
            interface MockDirectoryEntry {
                name: string;
                kind: EntryKind;
            }

            function joinPath(base: string, name: string) {
                return base ? `${base}/${name}` : name;
            }

            function requestUrl(filePath: string, query = '') {
                const encoded = filePath
                    .split('/')
                    .filter(Boolean)
                    .map(encodeURIComponent)
                    .join('/');
                return `${mockRoute}${encoded}${query}`;
            }

            async function requireOk(response: Response, entryName: string) {
                if (response.ok) return;
                const errorName =
                    response.status === 404
                        ? 'NotFoundError'
                        : response.status === 409
                            ? 'InvalidModificationError'
                            : 'InvalidStateError';
                throw new DOMException(
                    (await response.text()) || `Filesystem operation failed: ${entryName}`,
                    errorName,
                );
            }

            async function toBytes(chunk: unknown): Promise<Uint8Array> {
                if (typeof chunk === 'string') {
                    return new TextEncoder().encode(chunk);
                }
                if (chunk instanceof Blob) {
                    return new Uint8Array(await chunk.arrayBuffer());
                }
                if (chunk instanceof ArrayBuffer) {
                    return new Uint8Array(chunk);
                }
                if (ArrayBuffer.isView(chunk)) {
                    return new Uint8Array(
                        chunk.buffer,
                        chunk.byteOffset,
                        chunk.byteLength,
                    );
                }
                throw new TypeError('Unsupported mock filesystem write payload');
            }

            class MockFileSystemWritableStream {
                private readonly chunks: Uint8Array[] = [];

                constructor(private readonly filePath: string) {}

                async write(chunk: unknown) {
                    this.chunks.push(await toBytes(chunk));
                }

                async close() {
                    const size = this.chunks.reduce(
                        (total, chunk) => total + chunk.byteLength,
                        0,
                    );
                    const body = new Uint8Array(size);
                    let offset = 0;
                    for (const chunk of this.chunks) {
                        body.set(chunk, offset);
                        offset += chunk.byteLength;
                    }
                    const response = await fetch(requestUrl(this.filePath), {
                        method: 'PUT',
                        headers: { 'content-type': 'application/octet-stream' },
                        body,
                    });
                    await requireOk(response, this.filePath);
                }
            }

            class MockFileSystemHandle {
                constructor(
                    readonly kind: EntryKind,
                    readonly name: string,
                    readonly path: string,
                ) {}

                async isSameEntry(other: MockFileSystemHandle) {
                    return this.kind === other.kind && this.path === other.path;
                }

                async queryPermission() {
                    return 'granted' as PermissionState;
                }

                async requestPermission() {
                    return 'granted' as PermissionState;
                }
            }

            class MockFileSystemFileHandle extends MockFileSystemHandle {
                constructor(name: string, filePath: string) {
                    super('file', name, filePath);
                }

                async getFile() {
                    const response = await fetch(requestUrl(this.path));
                    await requireOk(response, this.path);
                    const blob = await response.blob();
                    return new File([blob], this.name, {
                        type: blob.type,
                        lastModified: Date.now(),
                    });
                }

                async createWritable() {
                    return new MockFileSystemWritableStream(this.path);
                }
            }

            class MockFileSystemDirectoryHandle extends MockFileSystemHandle {
                constructor(name: string, directoryPath: string) {
                    super('directory', name, directoryPath);
                }

                async getDirectoryHandle(
                    name: string,
                    options: FileSystemGetDirectoryOptions = {},
                ) {
                    const childPath = joinPath(this.path, name);
                    const response = await fetch(
                        requestUrl(
                            childPath,
                            `?kind=directory&create=${options.create === true}`,
                        ),
                        { method: 'POST' },
                    );
                    await requireOk(response, childPath);
                    return new MockFileSystemDirectoryHandle(name, childPath);
                }

                async getFileHandle(
                    name: string,
                    options: FileSystemGetFileOptions = {},
                ) {
                    const childPath = joinPath(this.path, name);
                    const response = await fetch(
                        requestUrl(
                            childPath,
                            `?kind=file&create=${options.create === true}`,
                        ),
                        { method: 'POST' },
                    );
                    await requireOk(response, childPath);
                    return new MockFileSystemFileHandle(name, childPath);
                }

                async removeEntry(
                    name: string,
                    options: FileSystemRemoveOptions = {},
                ) {
                    const childPath = joinPath(this.path, name);
                    const response = await fetch(
                        requestUrl(
                            childPath,
                            `?recursive=${options.recursive === true}`,
                        ),
                        { method: 'DELETE' },
                    );
                    if (response.status === 404) return;
                    await requireOk(response, childPath);
                }

                async resolve(possibleDescendant: MockFileSystemHandle) {
                    if (!possibleDescendant.path.startsWith(this.path)) return null;
                    return possibleDescendant.path
                        .slice(this.path.length)
                        .split('/')
                        .filter(Boolean);
                }

                async *entries() {
                    const response = await fetch(requestUrl(this.path, '?dir=true'));
                    await requireOk(response, this.path);
                    const entries = (await response.json()) as MockDirectoryEntry[];

                    for (const entry of entries) {
                        const childPath = joinPath(this.path, entry.name);
                        const handle =
                            entry.kind === 'directory'
                                ? new MockFileSystemDirectoryHandle(entry.name, childPath)
                                : new MockFileSystemFileHandle(entry.name, childPath);
                        yield [entry.name, handle] as const;
                    }
                }

                async *values() {
                    for await (const [, handle] of this.entries()) {
                        yield handle;
                    }
                }

                async *keys() {
                    for await (const [name] of this.entries()) {
                        yield name;
                    }
                }
            }

            const rootHandle = new MockFileSystemDirectoryHandle(
                pickerRootName,
                '',
            );

            Object.defineProperty(window, 'showDirectoryPicker', {
                configurable: true,
                value: async () => rootHandle,
            });
            Object.defineProperty(window, 'showSaveFilePicker', {
                configurable: true,
                value: async (options?: SaveFilePickerOptions) => {
                    const name = options?.suggestedName ?? 'export.mp4';
                    return rootHandle.getFileHandle(name, { create: true });
                },
            });
        },
        {
            mockRoute: MOCK_FS_ROUTE,
            pickerRootName: rootName,
        },
    );
}
