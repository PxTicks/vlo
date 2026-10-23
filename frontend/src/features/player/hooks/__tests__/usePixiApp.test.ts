import type {
  Application,
  Container,
  Rectangle,
  Renderer,
  Ticker,
} from "pixi.js";
import { StrictMode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePixiApp } from "../usePixiApp";
import { usePlayerStore } from "../../usePlayerStore";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    beginExportRun,
    resetExportRunLogForTests,
} from "../../../../core/export/exportRunLog";

import { getActivePixiApplication } from "../../../../core/pixi/activeApplication";

const { initMock, applications, discardBrushBuffersForRenderer } = vi.hoisted(() => ({
    initMock: vi.fn<Application["init"]>(),
    applications: [] as Application[],
    discardBrushBuffersForRenderer: vi.fn(),
}));

vi.mock("../../../masks/runtime/brushBufferRegistry", () => ({
    discardBrushBuffersForRenderer,
}));

// Mock Pixi
vi.mock("pixi.js", async () => {
    const original = await vi.importActual<typeof import("pixi.js")>("pixi.js");
    const { fake } = await import("../../../../testUtils/libraryFakes");
    return {
        ...original,
        Application: class MockApplication implements Partial<Application> {
            constructor() {
                applications.push(this as unknown as Application);
            }
            init = initMock;
            destroy = vi.fn<Application["destroy"]>();
            stage = fake<Container>({
                eventMode: 'passive', // Default
                hitArea: null,
                addChild: vi.fn<Container["addChild"]>(),
                removeChild: vi.fn<Container["removeChild"]>(),
            });
            renderer = fake<Renderer>({
                resize: vi.fn<Renderer["resize"]>(),
            });
            ticker = fake<Ticker>({
                start: vi.fn<Ticker["start"]>(),
                stop: vi.fn<Ticker["stop"]>(),
            });
            screen = fake<Rectangle>({ width: 100, height: 100 }); // Mock screen rect
        }
    };
});

describe("usePixiApp", () => {
    let containerRef: { current: HTMLDivElement | null };
    let canvasRef: { current: HTMLCanvasElement | null };

    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class ResizeObserver {
            observe = vi.fn();
            disconnect = vi.fn();
        });

        containerRef = { 
            current: {
                clientWidth: 800,
                clientHeight: 600,
            } as HTMLDivElement 
        };
        canvasRef = { current: document.createElement("canvas") };
        applications.length = 0;
        initMock.mockReset().mockResolvedValue(undefined);
        resetExportRunLogForTests();
        usePlayerStore.getState().setIsPlaying(false);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    async function renderApp() {
        const hook = renderHook(() => usePixiApp(containerRef as React.RefObject<HTMLDivElement>, canvasRef as React.RefObject<HTMLCanvasElement>));
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        const app = hook.result.current.pixiApp!;
        return app as unknown as { ticker: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } };
    }

    it("stops the live preview for a project export and resumes it afterwards", async () => {
        const app = await renderApp();
        expect(app.ticker.start).toHaveBeenCalled();
        app.ticker.start.mockClear();

        let run!: ReturnType<typeof beginExportRun>;
        act(() => {
            run = beginExportRun({ kind: "project", startTicks: 0, endTicks: 96_000 });
        });
        expect(app.ticker.stop).toHaveBeenCalled();
        expect(app.ticker.start).not.toHaveBeenCalled();

        act(() => run.complete());
        expect(app.ticker.start).toHaveBeenCalledOnce();
    });

    it("pauses playback when a project export starts, whoever starts it", async () => {
        usePlayerStore.getState().setIsPlaying(true);
        const app = await renderApp();
        act(() => {
            beginExportRun({ kind: "project", startTicks: 0, endTicks: 96_000 });
        });
        expect(usePlayerStore.getState().isPlaying).toBe(false);
        // Paused, and still no live preview while the export runs.
        expect(app.ticker.stop).toHaveBeenCalled();
        expect(app.ticker.start).not.toHaveBeenCalled();
    });

    it("keeps the live preview running during a range render", async () => {
        const app = await renderApp();
        app.ticker.stop.mockClear();
        act(() => {
            beginExportRun({ kind: "range", startTicks: 0, endTicks: 96_000 });
        });
        expect(app.ticker.stop).not.toHaveBeenCalled();
    });

    it("should initialize app and enable global stage interactivity", async () => {
        const { result } = renderHook(() => usePixiApp(containerRef as React.RefObject<HTMLDivElement>, canvasRef as React.RefObject<HTMLCanvasElement>));

        // Wait for async init
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
        });

        const app = result.current.pixiApp;
        expect(app).toBeDefined();
        
        // Assertions for the fix
        expect(app!.stage.eventMode).toBe("static");
        expect(app!.stage.hitArea).toBe(app!.screen);
    });

    async function mountPreview() {
        const hook = renderHook(() => usePixiApp(containerRef, canvasRef));
        await waitFor(() => expect(hook.result.current.pixiApp).not.toBeNull());
        return hook;
    }

    function loseContext() {
        const event = new Event("webglcontextlost", { cancelable: true });
        act(() => { canvasRef.current!.dispatchEvent(event); });
        return event;
    }

    it("pauses playback and withdraws the scene immediately on context loss", async () => {
        const { result } = await mountPreview();
        const app = result.current.pixiApp!;
        act(() => usePlayerStore.getState().setIsPlaying(true));

        expect(loseContext().defaultPrevented).toBe(true);

        expect(usePlayerStore.getState().isPlaying).toBe(false);
        expect(result.current.pixiApp).toBeNull();
        expect(result.current.isRecovering).toBe(true);
        expect(app.ticker.stop).toHaveBeenCalled();
        expect(getActivePixiApplication()).toBeNull();
        expect(discardBrushBuffersForRenderer).toHaveBeenCalledWith(app.renderer);
    });

    it.each(["restored", "timeout"])("rebuilds scene resources after %s", async (path) => {
        const { result } = await mountPreview();
        const original = result.current.pixiApp!;
        vi.useFakeTimers();
        loseContext();
        // Player replaces the DOM canvas when canvasKey changes. The ref here
        // emulates that commit without mocking the context-loss event itself.
        canvasRef.current = document.createElement("canvas");
        if (path === "restored") {
            // The restored event belongs to the retiring canvas.
            const canvas = initMock.mock.calls[0][0] as { canvas: HTMLCanvasElement };
            act(() => canvas.canvas.dispatchEvent(new Event("webglcontextrestored")));
        }
        await act(async () => { await vi.advanceTimersByTimeAsync(path === "restored" ? 0 : 3_000); });

        expect(result.current.canvasKey).toBe(1);
        expect(result.current.pixiApp).not.toBe(original);
        expect(result.current.pixiApp).not.toBeNull();
        expect(original.destroy).toHaveBeenCalledOnce();
        expect(result.current.isRecovering).toBe(false);
        expect(getActivePixiApplication()).toBe(result.current.pixiApp);
        expect(usePlayerStore.getState().isPlaying).toBe(false);
    });

    it("keeps the recovered ticker stopped during a project export", async () => {
        const { result } = await mountPreview();
        act(() => { beginExportRun({ kind: "project", startTicks: 0, endTicks: 96_000 }); });
        vi.useFakeTimers();
        loseContext();
        canvasRef.current = document.createElement("canvas");
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(result.current.pixiApp).not.toBeNull();
        expect(result.current.pixiApp!.ticker.start).not.toHaveBeenCalled();
    });

    it("offers retry when the GPU cannot create a replacement renderer", async () => {
        const { result } = await mountPreview();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        initMock.mockRejectedValueOnce(new Error("GPU unavailable"));
        vi.useFakeTimers();
        loseContext();
        canvasRef.current = document.createElement("canvas");
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(result.current.pixiApp).toBeNull();
        expect(result.current.error).toMatch(/could not start/);
        expect(result.current.isRecovering).toBe(false);

        canvasRef.current = document.createElement("canvas");
        await act(async () => result.current.retry());
        expect(result.current.pixiApp).not.toBeNull();
        expect(result.current.error).toBeNull();
        consoleError.mockRestore();
    });

    it("cancels recovery and removes canvas listeners on unmount", async () => {
        const { result, unmount } = await mountPreview();
        const original = result.current.pixiApp!;
        vi.useFakeTimers();
        loseContext();
        unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        const event = new Event("webglcontextlost", { cancelable: true });
        canvasRef.current!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(applications).toHaveLength(1);
        expect(original.destroy).toHaveBeenCalledOnce();
        expect(getActivePixiApplication()).toBeNull();
    });

    it("destroys an initialization that finishes after unmount without publishing it", async () => {
        let finishInit!: () => void;
        initMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishInit = resolve; }));
        const { unmount } = renderHook(() => usePixiApp(containerRef, canvasRef));
        await act(async () => {});
        const original = applications[0];
        unmount();
        await act(async () => finishInit());
        expect(original.destroy).toHaveBeenCalledOnce();
        expect(getActivePixiApplication()).toBeNull();
    });

    it("initializes only the live StrictMode effect", async () => {
        const { result } = renderHook(() => usePixiApp(containerRef, canvasRef), { wrapper: StrictMode });
        await waitFor(() => expect(result.current.pixiApp).not.toBeNull());
        expect(applications).toHaveLength(1);
        expect(getActivePixiApplication()).toBe(result.current.pixiApp);
    });

});
