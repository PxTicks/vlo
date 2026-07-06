// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileSystemService } from "../FileSystemService";
import { projectTemporaryFileService } from "../ProjectTemporaryFileService";

describe("ProjectTemporaryFileService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores iframe selections outside the persistent asset library", async () => {
    const writeFile = vi
      .spyOn(fileSystemService, "writeFile")
      .mockResolvedValue(undefined);
    const file = new File(["video"], "selection.mp4", {
      type: "video/mp4",
    });

    const path = await projectTemporaryFileService.writeIframeSelectionFile(
      "selection-1",
      "video",
      file,
    );

    expect(path).toBe(
      ".vloproject/temporary/iframe-selections/selection-1-video.mp4",
    );
    expect(writeFile).toHaveBeenCalledWith(path, file);
  });

  it("clears the temporary tree and notifies runtime stores", async () => {
    vi.spyOn(fileSystemService, "getHandle").mockReturnValue({} as never);
    const removeEntry = vi
      .spyOn(fileSystemService, "removeEntry")
      .mockResolvedValue(undefined);
    const onClear = vi.fn();
    const unsubscribe = projectTemporaryFileService.onClear(onClear);

    await projectTemporaryFileService.clearTemporaryFiles();
    unsubscribe();

    expect(onClear).toHaveBeenCalledOnce();
    expect(removeEntry).toHaveBeenCalledWith(".vloproject/temporary", {
      recursive: true,
    });
  });
});
