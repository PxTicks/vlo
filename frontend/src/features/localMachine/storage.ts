import { API_BASE_URL } from "../../config";

export let localMachineEnabled = false;
export let sharedRoots: Record<string, string> = {};
export async function initializeLocalMachine() {
  const response = await fetch(`${API_BASE_URL}/api/machine/status`);
  if (response.ok) {
    const status = await response.json();
    localMachineEnabled = status.enabled === true;
    sharedRoots = status.roots;
  }
}

export async function machineFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API_BASE_URL}/api/machine/${path}`, init);
  if (!response.ok) {
    const error = await response.text();
    throw new DOMException(error, response.status === 404 ? "NotFoundError" : "OperationError");
  }
  return response;
}
function endpoint(action: string, root: string, path: string, extra: Record<string, string> = {}) {
  return `fs/${action}?${new URLSearchParams({ root, path, ...extra })}`;
}
function child(path: string, name: string) {
  if (!name || name === "." || name === ".." || /[\\/:]/.test(name)) throw new Error("Invalid entry name");
  return path ? `${path}/${name}` : name;
}

class MachineHandle {
  readonly name: string;
  readonly root: string;
  readonly path: string;
  constructor(root: string, path: string) {
    this.root = root; this.path = path;
    this.name = path.split("/").pop() || sharedRoots[root]?.split(/[\\/]/).pop() || root;
  }
  async queryPermission(): Promise<PermissionState> { return "granted"; }
  async requestPermission(): Promise<PermissionState> { return "granted"; }
  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other instanceof MachineHandle && other.root === this.root && other.path === this.path;
  }
}

class MachineFile extends MachineHandle {
  readonly kind = "file";
  async getFile(): Promise<File> {
    const response = await machineFetch(endpoint("file", this.root, this.path));
    return new File([await response.blob()], this.name, { type: response.headers.get("content-type") || "application/octet-stream" });
  }
  async createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
    if (options?.keepExistingData) throw new Error("Local machine writer requires a fresh transaction");
    const staged = `${this.path}.${crypto.randomUUID()}.writing`;
    let position = 0;
    let closed = false;
    await machineFetch(endpoint("file", this.root, staged), { method: "PUT", body: new Blob([]) });
    const writer = {
      write: async (chunk: FileSystemWriteChunkType) => {
        if (closed) throw new Error("Writer closed");
        let data: FileSystemWriteChunkType = chunk;
        if (typeof chunk === "object" && !(chunk instanceof Blob) && !ArrayBuffer.isView(chunk) && !(chunk instanceof ArrayBuffer) && "type" in chunk) {
          if (chunk.type === "seek") { if (chunk.position == null) throw new Error("Seek needs a position"); position = chunk.position; return; }
          if (chunk.type === "truncate") {
            await machineFetch(endpoint("file", this.root, staged, { position: "0", truncate: String(chunk.size) }), { method: "PUT", body: new Blob([]) });
            return;
          }
          position = chunk.position ?? position;
          if (chunk.data == null) throw new Error("Write needs data");
          data = chunk.data;
        }
        const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
        // Upload positional chunks without retaining a complete export in browser memory.
        for (let offset = 0; offset < blob.size; offset += 4*1024*1024) {
          const part = blob.slice(offset, offset + 4*1024*1024);
          await machineFetch(endpoint("file", this.root, staged, { position: String(position) }), { method: "PUT", body: part });
          position += part.size;
        }
      },
      close: async () => {
        if (closed) return;
        await machineFetch(`fs/move?${new URLSearchParams({ root: this.root, source: staged, destination: this.path })}`, { method: "POST" });
        closed = true;
      },
      abort: async () => { if (!closed) await machineFetch(endpoint("entry", this.root, staged), { method: "DELETE" }); closed = true; },
      seek: async (offset: number) => { position = offset; },
      truncate: async (size: number) => writer.write({ type: "truncate", size }),
    };
    // Original project/export services use the file writer protocol, not WritableStream internals.
    return writer as unknown as FileSystemWritableFileStream;
  }
}

class MachineDirectory extends MachineHandle {
  readonly kind = "directory";
  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
    const path = child(this.path, name);
    if (options?.create) await machineFetch(endpoint("directory", this.root, path), { method: "POST" });
    const entry = await (await machineFetch(endpoint("stat", this.root, path))).json();
    if (entry.kind !== "directory") throw new DOMException("Entry is not a directory", "TypeMismatchError");
    return machineDirectory(this.root, path);
  }
  async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
    const path = child(this.path, name);
    try {
      const entry = await (await machineFetch(endpoint("stat", this.root, path))).json();
      if (entry.kind !== "file") throw new DOMException("Entry is not a file", "TypeMismatchError");
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError" || !options?.create) throw error;
      await machineFetch(endpoint("file", this.root, path), { method: "PUT", body: new Blob([]) });
    }
    return new MachineFile(this.root, path) as unknown as FileSystemFileHandle;
  }
  async removeEntry(name: string, options?: FileSystemRemoveOptions) {
    await machineFetch(endpoint("entry", this.root, child(this.path, name), { recursive: String(options?.recursive ?? false) }), { method: "DELETE" });
  }
  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    const entries: Array<{name: string; kind: string}> = await (await machineFetch(endpoint("list", this.root, this.path))).json();
    for (const entry of entries) yield [entry.name, (entry.kind === "directory" ? new MachineDirectory(this.root, child(this.path, entry.name)) : new MachineFile(this.root, child(this.path, entry.name))) as unknown as FileSystemHandle];
  }
  async *values() { for await (const [, entry] of this.entries()) yield entry; }
  async *keys() { for await (const [name] of this.entries()) yield name; }
  [Symbol.asyncIterator]() { return this.entries(); }
  async resolve(other: FileSystemHandle) {
    if (!(other instanceof MachineHandle) || other.root !== this.root) return null;
    const prefix = this.path ? `${this.path}/` : "";
    return other.path.startsWith(prefix) ? other.path.slice(prefix.length).split("/") : null;
  }
}

export function machineDirectory(root = "projects", path = ""): FileSystemDirectoryHandle {
  return new MachineDirectory(root, path) as unknown as FileSystemDirectoryHandle;
}
export function machineHandlePath(handle: FileSystemHandle): string | null {
  return handle instanceof MachineHandle && handle.root === "projects" ? handle.path : null;
}
export async function machineExportHandle(project: FileSystemDirectoryHandle, name: string) {
  if (machineHandlePath(project) === null) throw new Error("Export requires a shared-root project");
  return (await project.getDirectoryHandle("exports", { create: true })).getFileHandle(name, { create: true });
}
