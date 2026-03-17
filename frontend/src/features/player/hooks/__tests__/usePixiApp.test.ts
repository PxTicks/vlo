import { renderHook, act } from "@testing-library/react";
import { usePixiApp } from "../usePixiApp";
import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock Pixi
vi.mock("pixi.js", async () => {
    const original = await vi.importActual("pixi.js");
    return {
        ...original,
        Application: class MockApplication {
            init = vi.fn().mockResolvedValue(undefined);
            destroy = vi.fn();
            stage = {
                eventMode: 'passive', // Default
                hitArea: null,
                addChild: vi.fn(),
                removeChild: vi.fn(),
            };
            renderer = {
                resize: vi.fn(),
            };
            ticker = {
                start: vi.fn(),
                stop: vi.fn(),
            };
            screen = { width: 100, height: 100 }; // Mock screen rect
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
