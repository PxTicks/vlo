import { Page } from '@playwright/test';

/**
 * Injects a mock implementation of the File System Access API into the browser page.
 * This allows specialized tests to "Open" a project folder without native file pickers.
 * 
 * The mock treats local network requests to /__mock-fs/ as the "disk".
 */
export async function installMockFileSystem(page: Page, rootName: string = "Untitled Project") {
    await page.addInitScript((rootName) => {
        class MockFileSystemWritableStream {
            private readonly path: string;

            constructor(path: string) {
                this.path = path;
            }

            async write(chunk: unknown) {
                console.log(`[MockFS] Wrote to ${this.path}`, chunk);
            }

            async close() {
                return;
            }
        }
        
        class MockFileSystemHandle {
            kind: 'file' | 'directory';
            name: string;
            public path: string;

            constructor(kind: 'file' | 'directory', name: string, path: string) {
                this.kind = kind;
                this.name = name;
                this.path = path;
            }

            async isSameEntry(other: MockFileSystemHandle) {
                return this.path === other.path;
            }

            async queryPermission() { return 'granted'; }
            async requestPermission() { return 'granted'; }
        }

        class MockFileSystemFileHandle extends MockFileSystemHandle {
            constructor(name: string, path: string) {
                super('file', name, path);
            }

            async getFile() {
                // Fetch content from intercepted route
                const response = await fetch(`/__mock-fs/${this.path}`);
                if (!response.ok) throw new Error(`File not found: ${this.path}`);
                const blob = await response.blob();
                return new File([blob], this.name, { type: blob.type, lastModified: Date.now() });
            }

            async createWritable() {
                return new MockFileSystemWritableStream(this.path);
            }
        }

        class MockFileSystemDirectoryHandle extends MockFileSystemHandle {
            constructor(name: string, path: string) {
                super('directory', name, path);
            }

            async getDirectoryHandle(name: string) {
                // For simplicity in this specific test fixture, we assume flat structure 
                // or just construct path. A real mock might check existence via HEAD request.
                // For "Open Project" flow, we mostly strictly read.
                const newPath = this.path ? `${this.path}/${name}` : name;
                return new MockFileSystemDirectoryHandle(name, newPath);
            }

            async getFileHandle(name: string) {
                const newPath = this.path ? `${this.path}/${name}` : name;
                return new MockFileSystemFileHandle(name, newPath);
            }

            async removeEntry(name: string) {
                console.log(`[MockFS] Removed ${name} from ${this.path}`);
            }
            
            async resolve(possibleDescendant: MockFileSystemHandle) {
                if (!possibleDescendant.path.startsWith(this.path)) return null;
                const relative = possibleDescendant.path.slice(this.path.length);
                return relative.split('/').filter(Boolean);
            }

            // Async Iterator for entries
            async *entries() {
                // We need to fetch the directory listing from the mock server
                const response = await fetch(`/__mock-fs/${this.path}?dir=true`);
                if (!response.ok) return; // Empty or error
                const files = await response.json(); // Expect ["file1.txt", "subdir"]
                
                for (const name of files) {
                    const childPath = this.path ? `${this.path}/${name}` : name;

                    // Determine entry type by probing whether it is listable as a directory.
                    const childDirProbe = await fetch(`/__mock-fs/${childPath}?dir=true`);
                    const isDirectory = childDirProbe.ok;

                    if (isDirectory) {
                        yield [name, new MockFileSystemDirectoryHandle(name, childPath)];
                    } else {
                        yield [name, new MockFileSystemFileHandle(name, childPath)];
                    }
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

        // Override window.showDirectoryPicker
        // @ts-expect-error - Override native API
        window.showDirectoryPicker = async () => {
            console.log("[MockFS] showDirectoryPicker called");
            return new MockFileSystemDirectoryHandle(rootName, "");
        };

    }, rootName);
}
