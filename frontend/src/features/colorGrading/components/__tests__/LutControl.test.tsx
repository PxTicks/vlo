import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { parseCubeLut } from "../../../../core/color";
import type { CustomControlRenderProps } from "../../../panelUI";
import type { Asset } from "../../../../types/Asset";
import { extensionLutRegistry } from "../../../extensions/registry/publicApi";

const {
  useAssetMock,
  ensureAssetFileLoadedMock,
  ingestExtensionAssetMock,
} =
  vi.hoisted(() => ({
    useAssetMock: vi.fn<(assetId: string | null | undefined) => Asset | undefined>(),
    ensureAssetFileLoadedMock: vi.fn<(assetId: string) => Promise<File | null>>(),
    ingestExtensionAssetMock: vi.fn(),
  }));

vi.mock("../../../userAssets", () => ({
  useAsset: useAssetMock,
  ensureAssetFileLoaded: ensureAssetFileLoadedMock,
}));

vi.mock("../../../extensions/assets/publicApi", () => ({
  ingestExtensionAsset: ingestExtensionAssetMock,
}));

import { LutControl } from "../LutControl";

// jsdom's Blob/File lack .text(); the component and assertions rely on it.
if (typeof Blob.prototype.text !== "function") {
  Object.defineProperty(Blob.prototype, "text", {
    configurable: true,
    writable: true,
    value(this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    },
  });
}

const IDENTITY_2_CUBE = [
  "LUT_3D_SIZE 2",
  "0 0 0",
  "1 0 0",
  "0 1 0",
  "1 1 0",
  "0 0 1",
  "1 0 1",
  "0 1 1",
  "1 1 1",
].join("\n");

const control: CustomControlRenderProps["control"] = {
  type: "custom",
  label: "LUT",
  name: "_lut",
};

function renderControl(
  values: Record<string, unknown>,
  onCommitMany = vi.fn(),
) {
  render(
    <LutControl
      control={control}
      value={undefined}
      values={values}
      onCommit={vi.fn()}
      onCommitMany={onCommitMany}
      groupId="color_grade_lut"
      transformId="grade-1"
    />,
  );
  return onCommitMany;
}

describe("LutControl", () => {
  beforeEach(() => {
    useAssetMock.mockReturnValue(undefined);
    ingestExtensionAssetMock.mockResolvedValue({ id: "lut-asset-1" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ingests a browsed .cube file and commits its asset id", async () => {
    const onCommitMany = renderControl({ lutAssetId: null, lutIntensity: 1 });

    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(input).not.toBeNull();
    const file = new File([IDENTITY_2_CUBE], "identity.cube", {
      type: "text/plain",
    });
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() =>
      expect(onCommitMany).toHaveBeenCalledWith({ lutAssetId: "lut-asset-1" }),
    );
    expect(ingestExtensionAssetMock).toHaveBeenCalledWith({
      name: "identity.cube",
      type: "lut",
      blob: file,
    });
  });

  it("materializes a contributed look-pack LUT before committing it", async () => {
    const registration = extensionLutRegistry.registerPackageLut(
      "example.looks",
      {
        id: "warm",
        apiVersion: 1,
        label: "Warm",
        order: 0,
        resourceUrl: "/look-pack/warm.cube",
        packageVersion: "1.0.0",
        packageDigest: `sha256:${"a".repeat(64)}`,
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers(),
        blob: async () => new Blob([IDENTITY_2_CUBE], { type: "text/plain" }),
      })),
    );
    ingestExtensionAssetMock.mockResolvedValue({ id: "project-lut" });
    const onCommitMany = renderControl({ lutAssetId: null, lutIntensity: 1 });

    try {
      fireEvent.mouseDown(screen.getByRole("combobox"));
      fireEvent.click(await screen.findByText("Warm — example.looks"));

      await waitFor(() =>
        expect(onCommitMany).toHaveBeenCalledWith({ lutAssetId: "project-lut" }),
      );
      expect(ingestExtensionAssetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "example.looks.warm.cube",
          type: "lut",
        }),
      );
      expect(
        screen.getByText(/LUT is now stored in this project/i),
      ).toBeInTheDocument();

      fireEvent.mouseDown(screen.getByRole("combobox"));
      fireEvent.click(await screen.findByText("Warm — example.looks"));
      await waitFor(() => expect(onCommitMany).toHaveBeenCalledTimes(2));
    } finally {
      act(() => registration.dispose());
      vi.unstubAllGlobals();
    }
  });

  it("keeps a failed look-pack choice retryable", async () => {
    const registration = extensionLutRegistry.registerPackageLut(
      "example.looks",
      {
        id: "warm",
        apiVersion: 1,
        label: "Warm",
        order: 0,
        resourceUrl: "/look-pack/warm.cube",
        packageVersion: "1.0.0",
        packageDigest: `sha256:${"b".repeat(64)}`,
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([IDENTITY_2_CUBE], { type: "text/plain" }),
      })),
    );
    ingestExtensionAssetMock
      .mockRejectedValueOnce(new Error("Temporary ingest failure"))
      .mockResolvedValueOnce({ id: "project-lut" });
    const onCommitMany = renderControl({ lutAssetId: null, lutIntensity: 1 });

    try {
      fireEvent.mouseDown(screen.getByRole("combobox"));
      fireEvent.click(await screen.findByText("Warm — example.looks"));
      await screen.findByText("Temporary ingest failure");
      expect(screen.getByRole("combobox")).toHaveTextContent(
        "Apply from look packs",
      );

      fireEvent.mouseDown(screen.getByRole("combobox"));
      fireEvent.click(await screen.findByText("Warm — example.looks"));
      await waitFor(() =>
        expect(onCommitMany).toHaveBeenCalledWith({ lutAssetId: "project-lut" }),
      );
    } finally {
      act(() => registration.dispose());
      vi.unstubAllGlobals();
    }
  });

  it("surfaces a malformed cube rejection without committing it", async () => {
    ingestExtensionAssetMock.mockRejectedValue(
      new Error("Invalid .cube data"),
    );
    const onCommitMany = renderControl({ lutAssetId: null, lutIntensity: 1 });

    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    const file = new File(["LUT_3D_SIZE 2\nnot a number\n"], "broken.cube", {
      type: "text/plain",
    });
    fireEvent.change(input!, { target: { files: [file] } });

    await screen.findByRole("alert");
    expect(ingestExtensionAssetMock).toHaveBeenCalledOnce();
    expect(onCommitMany).not.toHaveBeenCalled();
  });

  it("shows the assigned LUT, clears it, and flags missing assets", () => {
    useAssetMock.mockReturnValue({
      id: "lut-asset-1",
      name: "teal.cube",
      type: "lut",
    } as Asset);
    const onCommitMany = renderControl({
      lutAssetId: "lut-asset-1",
      lutIntensity: 1,
    });

    expect(screen.getByText("teal.cube")).toBeInTheDocument();
    fireEvent.click(document.querySelector(".drop-slot-clear")!);
    expect(onCommitMany).toHaveBeenCalledWith({ lutAssetId: null });

    useAssetMock.mockReturnValue(undefined);
    renderControl({ lutAssetId: "gone", lutIntensity: 1 });
    expect(
      screen.getByText(/referenced LUT asset is missing/i),
    ).toBeInTheDocument();
  });

  it("exports the current grade as a valid 33³ .cube download", async () => {
    const objectUrls: string[] = [];
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      objectUrls.push(`blob:mock-${blobs.length}`);
      return objectUrls[objectUrls.length - 1];
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      renderControl({
        lutAssetId: null,
        lutIntensity: 1,
        exposure: 0.5,
        saturation: 1.2,
      });
      fireEvent.click(screen.getByRole("button", { name: /export \.cube/i }));

      await waitFor(() => expect(click).toHaveBeenCalled());
      const exported = parseCubeLut(await blobs[0].text());
      expect(exported.size).toBe(33);
      expect(exported.title).toBe("vlo color grade");
      // A brightening grade must lift the mid-gray lattice point.
      const mid = 16 + 16 * 33 + 16 * 33 * 33;
      expect(exported.data[mid * 3]).toBeGreaterThan(0.5);
      expect(revokeObjectURL).toHaveBeenCalled();
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
