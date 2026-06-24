import { vi } from "vitest";
import type { Mock } from "vitest";

interface MockDirectoryOptions {
  permission?: PermissionState;
  entries?: Array<[string, FileSystemHandle]>;
}

export type MockFileHandle = FileSystemFileHandle & {
  getFile: Mock<FileSystemFileHandle["getFile"]>;
  createWritable: Mock<FileSystemFileHandle["createWritable"]>;
  queryPermission: Mock<FileSystemFileHandle["queryPermission"]>;
  requestPermission: Mock<FileSystemFileHandle["requestPermission"]>;
};

export type MockDirectoryHandle = FileSystemDirectoryHandle & {
  getDirectoryHandle: Mock<FileSystemDirectoryHandle["getDirectoryHandle"]>;
  getFileHandle: Mock<FileSystemDirectoryHandle["getFileHandle"]>;
  removeEntry: Mock<FileSystemDirectoryHandle["removeEntry"]>;
  resolve: Mock<FileSystemDirectoryHandle["resolve"]>;
  queryPermission: Mock<FileSystemDirectoryHandle["queryPermission"]>;
  requestPermission: Mock<FileSystemDirectoryHandle["requestPermission"]>;
};

export function createMockFileHandle(
  name = "asset.bin",
  file = new File(["asset"], name),
): MockFileHandle {
  const writable = {
    write: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return {
    kind: "file",
    name,
    isSameEntry: vi.fn(async () => false),
    getFile: vi.fn(async () => file),
    createWritable: vi.fn(async () => writable),
    queryPermission: vi.fn(async () => "granted"),
    requestPermission: vi.fn(async () => "granted"),
  } as unknown as MockFileHandle;
}

export function createMockDirectoryHandle(
  name = "Project",
  options: MockDirectoryOptions = {},
): MockDirectoryHandle {
  const permission = options.permission ?? "granted";
  const entries = options.entries ?? [];
  return {
    kind: "directory",
    name,
    isSameEntry: vi.fn(async () => false),
    getDirectoryHandle: vi.fn(),
    getFileHandle: vi.fn(),
    removeEntry: vi.fn(async () => undefined),
    resolve: vi.fn(async () => null),
    queryPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => permission),
    entries: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield* entries;
      },
    })),
    keys: vi.fn(),
    values: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      yield* entries;
    },
  } as unknown as MockDirectoryHandle;
}
