import type {
  Application,
  Container,
  Rectangle,
  Renderer,
  Ticker,
} from "pixi.js";
import { renderHook, act } from "@testing-library/react";
import { usePixiApp } from "../usePixiApp";
import { usePlayerStore } from "../../usePlayerStore";
import { vi, describe, it, expect, beforeEach } from "vitest";
import {
    beginExportRun,
    resetExportRunLogForTests,
} from "../../../../core/export/exportRunLog";

// Mock Pixi
vi.mock("pixi.js", async () => {
    const original = await vi.importActual<typeof import("pixi.js")>("pixi.js");
    const { fake } = await import("../../../../testUtils/libraryFakes");
    return {
        ...original,
        Application: class MockApplication implements Partial<Application> {
            init = vi.fn<Application["init"]>().mockResolvedValue(undefined);
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
        canvasRef = { current: {} as HTMLCanvasElement };
        resetExportRunLogForTests();
        usePlayerStore.getState().setIsPlaying(false);
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
});
