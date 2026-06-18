import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComfyApiError,
  fetchOutputAsFile,
  generate,
  getConfig,
  getHealth,
  getHistory,
  getObjectInfo,
  getOutputViewUrl,
  getQueue,
  getWorkflowContent,
  getWorkflowRules,
  interrupt,
  listWorkflows,
  resolveWorkflowRules,
  saveWorkflowContent,
  submitPrompt,
  syncObjectInfo,
  updateConfig,
  uploadWorkflowJsonFiles,
} from "../comfyuiApi";
import type { GenerationRequest } from "../../pipeline/types";

interface ResponseInit {
  ok?: boolean;
  status?: number;
  contentType?: string;
  body?: unknown;
  text?: string;
  blobType?: string;
}

function makeResponse(init: ResponseInit = {}): Response {
  const {
    ok = true,
    status = ok ? 200 : 500,
    contentType = "application/json",
    body,
    text,
    blobType = "video/mp4",
  } = init;

  const bodyText =
    text ?? (body === undefined ? "" : JSON.stringify(body));

  const response = {
    ok,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    text: vi.fn(async () => bodyText),
    json: vi.fn(async () => (body === undefined ? JSON.parse(bodyText) : body)),
    blob: vi.fn(async () => new Blob([bodyText], { type: blobType })),
    clone() {
      return makeResponse(init);
    },
  };
  return response as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastFetchUrl(): string {
  return String(fetchMock.mock.calls.at(-1)?.[0]);
}

describe("comfyuiApi submitPrompt", () => {
  it("returns parsed response on success", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: { prompt_id: "p1", number: 1, node_errors: {} } }),
    );

    const result = await submitPrompt({ prompt: {}, client_id: "c1" });
    expect(result.prompt_id).toBe("p1");
    expect(lastFetchUrl()).toContain("/comfy/prompt");
  });

  it("throws ComfyApiError with extracted nested error message on failure", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: false,
        status: 422,
        body: { error: { message: "bad prompt" } },
      }),
    );

    await expect(submitPrompt({ prompt: {}, client_id: "c1" })).rejects.toThrow(
      /Prompt submission failed \(422\): bad prompt/,
    );
  });

  it("treats node_errors in a 200 response as a validation failure", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        body: {
          prompt_id: "p1",
          number: 1,
          node_errors: {
            "5": {
              class_type: "KSampler",
              errors: [{ message: "missing", details: "seed" }],
            },
          },
        },
      }),
    );

    await expect(
      submitPrompt({ prompt: {}, client_id: "c1" }),
    ).rejects.toMatchObject({
      name: "ComfyApiError",
      status: 400,
    });
  });
});

describe("comfyuiApi generate", () => {
  function baseRequest(): GenerationRequest {
    return {
      clientId: "client-1",
      projectId: "proj-1",
      deliveryContext: {
        planId: "plan-1",
        workflowName: "wf",
        workflowSourceId: "src",
        generationMetadata: {},
        postprocessConfig: {},
        autoFamilyRequestKey: null,
        usesSaveImageWebsocketOutputs: false,
        saveImageWebsocketNodeIds: [],
        replayInputs: null,
      },
      textInputs: {},
      imageInputs: {},
      audioInputs: {},
      videoInputs: {},
      pipelineInputs: {},
    } as unknown as GenerationRequest;
  }

  it("throws when delivery context is missing", async () => {
    await expect(
      generate({ ...baseRequest(), projectId: "" } as GenerationRequest),
    ).rejects.toThrow(/missing backend delivery context/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts multipart form data and forwards the abort signal", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: { prompt_id: "p9", number: 2, node_errors: {} } }),
    );
    const controller = new AbortController();

    const request = baseRequest();
    (request as unknown as { textInputs: Record<string, string> }).textInputs = {
      "3": "hello",
    };
    (request as unknown as { workflowId?: string }).workflowId = "wf-1";
    (request as unknown as { widgetInputs?: Record<string, string> }).widgetInputs =
      { seed: "42" };

    const result = await generate(request, { signal: controller.signal });
    expect(result.prompt_id).toBe("p9");

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/comfy/generate");
    expect((options as RequestInit).body).toBeInstanceOf(FormData);
    expect((options as RequestInit).signal).toBe(controller.signal);
    const form = (options as RequestInit).body as FormData;
    expect(form.get("project_id")).toBe("proj-1");
    expect(form.get("text_3")).toBe("hello");
    expect(form.get("workflow_id")).toBe("wf-1");
    expect(form.get("seed")).toBe("42");
  });

  it("wraps a non-ok generation response in a ComfyApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 500, body: { message: "boom" } }),
    );
    await expect(generate(baseRequest())).rejects.toThrow(
      /Generation failed \(500\): boom/,
    );
  });
});

describe("comfyuiApi simple endpoints", () => {
  it("interrupt resolves on success and throws on failure", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ text: "" }));
    await expect(interrupt()).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 503, contentType: "text/plain", text: "down" }),
    );
    await expect(interrupt()).rejects.toThrow(/Interrupt failed \(503\): down/);
  });

  it("getHealth and getConfig parse JSON", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { status: "ok" } }));
    expect(await getHealth()).toEqual({ status: "ok" });

    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: { comfyui_url: "http://x" } }),
    );
    expect(await getConfig()).toEqual({ comfyui_url: "http://x" });
  });

  it("updateConfig posts the new url", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: { comfyui_url: "http://y" } }),
    );
    expect(await updateConfig("http://y")).toEqual({ comfyui_url: "http://y" });
    const [, options] = fetchMock.mock.calls[0];
    expect((options as RequestInit).method).toBe("POST");
    expect((options as RequestInit).body).toContain("http://y");
  });

  it("getHistory, getQueue, getObjectInfo, syncObjectInfo return JSON", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ body: { h: 1 } }))
      .mockResolvedValueOnce(makeResponse({ body: { q: 1 } }))
      .mockResolvedValueOnce(makeResponse({ body: { o: 1 } }))
      .mockResolvedValueOnce(makeResponse({ body: { synced: true, node_classes: 3 } }));

    expect(await getHistory("p1")).toEqual({ h: 1 });
    expect(await getQueue()).toEqual({ q: 1 });
    expect(await getObjectInfo()).toEqual({ o: 1 });
    expect(await syncObjectInfo()).toEqual({ synced: true, node_classes: 3 });
  });

  it("throwRequestError handles an empty body (no detail suffix)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 404, text: "" }),
    );
    await expect(getQueue()).rejects.toThrow(/Queue fetch failed \(404\)$/);
  });
});

describe("comfyuiApi output helpers", () => {
  it("getOutputViewUrl encodes query params", () => {
    const url = getOutputViewUrl("a b.png", "sub", "temp");
    expect(url).toContain("/comfy/api/view?");
    expect(url).toContain("filename=a+b.png");
    expect(url).toContain("subfolder=sub");
    expect(url).toContain("type=temp");
  });

  it("fetchOutputAsFile returns a File on success", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ text: "data", blobType: "image/png" }),
    );
    const file = await fetchOutputAsFile("out.png", "", "output");
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("out.png");
  });

  it("fetchOutputAsFile logs and throws on failure", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 410, contentType: "text/plain", text: "gone" }),
    );
    await expect(fetchOutputAsFile("missing.png")).rejects.toThrow(
      /Output fetch failed \(410\): gone/,
    );
  });
});

describe("comfyuiApi workflow endpoints", () => {
  it("listWorkflows maps optional group fields", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        body: [
          { id: "1", name: "Plain" },
          {
            id: "2",
            name: "Grouped",
            group_id: "g",
            group_name: "Group",
            group_order: 3,
          },
        ],
      }),
    );

    const result = await listWorkflows();
    expect(result[0]).toEqual({ id: "1", name: "Plain" });
    expect(result[1]).toEqual({
      id: "2",
      name: "Grouped",
      groupId: "g",
      groupName: "Group",
      groupOrder: 3,
    });
  });

  it("getWorkflowContent and saveWorkflowContent hit the content endpoint", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { nodes: {} } }));
    expect(await getWorkflowContent("wf.json")).toEqual({ nodes: {} });
    expect(lastFetchUrl()).toContain("/comfy/workflow/content/");

    fetchMock.mockResolvedValueOnce(makeResponse({ text: "" }));
    await expect(
      saveWorkflowContent("wf.json", { a: 1 }, { info: true }),
    ).resolves.toBeUndefined();
    const [, options] = fetchMock.mock.calls[1];
    expect((options as RequestInit).method).toBe("PUT");
    expect((options as RequestInit).body).toContain("object_info");
  });

  it("uploadWorkflowJsonFiles returns the uploaded list", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        body: { uploaded: [{ filename: "a.json", kind: "workflow", workflow_id: "w" }] },
      }),
    );
    const files = [new File(["{}"], "a.json", { type: "application/json" })];
    const result = await uploadWorkflowJsonFiles(files);
    expect(result).toHaveLength(1);
    expect(result[0].workflow_id).toBe("w");
  });

  it("uploadWorkflowJsonFiles tolerates a non-array uploaded field", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { uploaded: null } }));
    expect(await uploadWorkflowJsonFiles([])).toEqual([]);
  });

  it("getWorkflowRules normalizes missing fields", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: {} }));
    const result = await getWorkflowRules("wf.json");
    expect(result.has_sidecar).toBe(false);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.rules).toBeDefined();
  });

  it("resolveWorkflowRules sends graph_data and workflow_id when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: { has_sidecar: true, warnings: [{ code: "x" }] } }),
    );
    const result = await resolveWorkflowRules({
      workflow: null,
      graphData: { g: 1 },
      workflowId: "wf-7",
    });
    expect(result.has_sidecar).toBe(true);
    const [, options] = fetchMock.mock.calls[0];
    const sent = JSON.parse((options as RequestInit).body as string);
    expect(sent.graph_data).toEqual({ g: 1 });
    expect(sent.workflow_id).toBe("wf-7");
  });
});

describe("ComfyApiError", () => {
  it("captures status and extracts node errors from the payload", () => {
    const error = new ComfyApiError("nope", 400, {
      node_errors: { "1": { class_type: "Foo" } },
    });
    expect(error.status).toBe(400);
    expect(error.nodeErrors).toEqual({ "1": { class_type: "Foo" } });
  });

  it("leaves nodeErrors null for non-record payloads", () => {
    const error = new ComfyApiError("nope", 400, "plain text");
    expect(error.nodeErrors).toBeNull();
    expect(error.payload).toBe("plain text");
  });
});
