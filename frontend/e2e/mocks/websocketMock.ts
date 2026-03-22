import { Page } from '@playwright/test';

/**
 * ComfyUI WebSocket event types matching ComfyUIWebSocket.ts interfaces.
 */
export interface MockComfyEvent {
    type: 'status' | 'progress' | 'executing' | 'executed' | 'execution_error' | 'error';
    data: Record<string, unknown>;
}

/**
 * Installs a browser-side WebSocket mock that intercepts connections to /comfy/ws.
 * Exposes a window.__mockWs object in the browser for test-driven event injection.
 *
 * Must be called before navigating to the app (uses page.addInitScript).
 */
export async function installWebSocketMock(page: Page) {
    await page.addInitScript(() => {
        const RealWebSocket = window.WebSocket;

        // Storage for mock instances keyed by URL
        const mockInstances: MockWsInstance[] = [];

        interface MockWsInstance {
            url: string;
            onopen: ((ev: Event) => void) | null;
            onmessage: ((ev: MessageEvent) => void) | null;
            onclose: ((ev: CloseEvent) => void) | null;
            onerror: ((ev: Event) => void) | null;
            readyState: number;
            binaryType: string;
            send: (data: unknown) => void;
            close: () => void;
            addEventListener: (type: string, handler: EventListenerOrEventListenerObject) => void;
            removeEventListener: (type: string, handler: EventListenerOrEventListenerObject) => void;
        }

        function createMockWs(url: string): MockWsInstance {
            const listeners: Record<string, Set<EventListenerOrEventListenerObject>> = {
                open: new Set(),
                message: new Set(),
                close: new Set(),
                error: new Set(),
            };

            const instance: MockWsInstance = {
                url,
                onopen: null,
                onmessage: null,
                onclose: null,
                onerror: null,
                readyState: 0, // CONNECTING
                binaryType: 'blob',

                send(_data: unknown) {
                    // No-op: mock swallows outbound messages
                },

                close() {
                    instance.readyState = 3; // CLOSED
                    const ev = new CloseEvent('close', { code: 1000, reason: 'mock close' });
                    if (instance.onclose) instance.onclose(ev);
                    listeners.close.forEach((h) => {
                        if (typeof h === 'function') h(ev);
                        else h.handleEvent(ev);
                    });
                },

                addEventListener(type: string, handler: EventListenerOrEventListenerObject) {
                    listeners[type]?.add(handler);
                },

                removeEventListener(type: string, handler: EventListenerOrEventListenerObject) {
                    listeners[type]?.delete(handler);
                },
            };

            mockInstances.push(instance);

            // Simulate async open after microtask to mimic real WS behavior
            setTimeout(() => {
                instance.readyState = 1; // OPEN
                const ev = new Event('open');
                if (instance.onopen) instance.onopen(ev);
                listeners.open.forEach((h) => {
                    if (typeof h === 'function') h(ev);
                    else h.handleEvent(ev);
                });

                // Send initial status event (queue empty)
                const statusEvent = new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'status',
                        data: { status: { exec_info: { queue_remaining: 0 } } },
                    }),
                });
                if (instance.onmessage) instance.onmessage(statusEvent);
                listeners.message.forEach((h) => {
                    if (typeof h === 'function') h(statusEvent);
                    else h.handleEvent(statusEvent);
                });
            }, 0);

            return instance;
        }

        // Override the WebSocket constructor
        // @ts-expect-error - Override native WebSocket
        window.WebSocket = function MockWebSocket(url: string, protocols?: string | string[]) {
            // Only intercept ComfyUI WebSocket connections
            if (url.includes('/comfy/ws')) {
                return createMockWs(url);
            }
            // Pass through non-ComfyUI connections to the real WebSocket
            return new RealWebSocket(url, protocols);
        } as unknown as typeof WebSocket;

        // Copy static properties
        Object.defineProperty(window.WebSocket, 'CONNECTING', { value: 0 });
        Object.defineProperty(window.WebSocket, 'OPEN', { value: 1 });
        Object.defineProperty(window.WebSocket, 'CLOSING', { value: 2 });
        Object.defineProperty(window.WebSocket, 'CLOSED', { value: 3 });
        Object.defineProperty(window.WebSocket, 'prototype', { value: RealWebSocket.prototype });

        // Expose control interface for test code
        (window as unknown as Record<string, unknown>).__mockWs = {
            /**
             * Push a JSON event to all connected mock ComfyUI WebSocket instances.
             */
            simulateEvent(type: string, data: Record<string, unknown>) {
                const payload = JSON.stringify({ type, data });
                for (const instance of mockInstances) {
                    if (instance.readyState !== 1) continue; // only OPEN
                    const ev = new MessageEvent('message', { data: payload });
                    if (instance.onmessage) instance.onmessage(ev);
                }
            },

            /** Get the number of active mock WS instances. */
            get instanceCount() {
                return mockInstances.filter((i) => i.readyState === 1).length;
            },
        };
    });
}

/**
 * Simulate a ComfyUI WebSocket event from test code.
 * Calls window.__mockWs.simulateEvent in the browser context.
 */
export async function simulateWsEvent(page: Page, type: string, data: Record<string, unknown>) {
    await page.evaluate(
        ({ type, data }) => {
            const mock = (window as unknown as Record<string, unknown>).__mockWs as {
                simulateEvent: (type: string, data: Record<string, unknown>) => void;
            } | undefined;
            if (!mock) throw new Error('WebSocket mock not installed');
            mock.simulateEvent(type, data);
        },
        { type, data },
    );
}

/**
 * Simulate a complete generation flow: executing → progress → executed.
 */
export async function simulateGenerationComplete(
    page: Page,
    promptId: string,
    outputNode: string,
    outputFilename: string,
) {
    await simulateWsEvent(page, 'executing', {
        node: outputNode,
        prompt_id: promptId,
    });

    await simulateWsEvent(page, 'progress', {
        value: 100,
        max: 100,
        prompt_id: promptId,
        node: outputNode,
    });

    await simulateWsEvent(page, 'executed', {
        node: outputNode,
        prompt_id: promptId,
        output: {
            gifs: [{ filename: outputFilename, subfolder: '', type: 'output' }],
        },
    });

    // Signal queue empty
    await simulateWsEvent(page, 'status', {
        status: { exec_info: { queue_remaining: 0 } },
    });
}
