import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComfyApiError,
  fetchOutputAsFile,
  generate,
  getConfig,
  getHealth,
  getObjectInfo,
  getOutputViewUrl,
  getWorkflowContent,
  getWorkflowRules,
  interrupt,
  listWorkflows,
  resolveWorkflowRules,
  saveWorkflowContent,
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

function imageFile(name: string): File {
  return new File(["image"], name, { type: "image/png" });
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

  it("serializes every optional request input", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: { prompt_id: "all", number: 3, node_errors: {} } }),
    );
    const request = baseRequest() as GenerationRequest & {
      promptIsPreResolved: boolean;
    };
    request.workflow = { "1": { class_type: "LoadImage" } };
    request.graphData = { nodes: [] };
    request.workflowRules = { version: 1 } as never;
    request.inputMetadata = { "1": { kind: "image" } } as never;
    request.imageInputs = { "1": imageFile("image.png") };
    request.audioInputs = {
      "2": new File(["audio"], "audio.wav", { type: "audio/wav" }),
    };
    request.videoInputs = {
      "3": new File(["video"], "video.mp4", { type: "video/mp4" }),
    };
    request.cachedMediaInputs = { "4": { assetId: "cached" } } as never;
    request.derivedWidgetInputs = { derived_seed: "12" };
    request.widgetModes = { mode: "fixed" };
    request.promptIsPreResolved = true;

    await generate(request);

    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("workflow")).toContain("LoadImage");
    expect(form.get("graph_data")).toContain("nodes");
    expect(form.get("workflow_rules")).toContain("version");
    expect(form.get("input_metadata")).toContain("image");
    expect(form.get("image_1")).toBeInstanceOf(File);
    expect(form.get("audio_2")).toBeInstanceOf(File);
    expect(form.get("video_3")).toBeInstanceOf(File);
    expect(form.get("cached_media_inputs")).toContain("cached");
    expect(form.get("derived_seed")).toBe("12");
    expect(form.get("mode")).toBe("fixed");
    expect(form.get("prompt_is_pre_resolved")).toBe("true");
  });

  it("wraps a non-ok generation response in a ComfyApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 500, body: { message: "boom" } }),
    );
    await expect(generate(baseRequest())).rejects.toThrow(
      /Generation failed \(500\): boom/,
    );
  });

  it("rejects generation responses containing node errors", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        body: {
          prompt_id: "invalid",
          number: 1,
          node_errors: { "9": { class_type: "Broken" } },
        },
      }),
    );
    await expect(generate(baseRequest())).rejects.toMatchObject({
      name: "ComfyApiError",
      status: 400,
    });
  });

  it.each([
    {
      body: "plain failure",
      contentType: "text/plain",
      expected: "plain failure",
    },
    {
      body: { message: "top-level failure" },
      contentType: "application/json",
      expected: "top-level failure",
    },
    {
      text: "{bad-json",
      contentType: "application/json",
      expected: "{bad-json",
    },
  ])("extracts useful error detail from $contentType", async (response) => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: false,
        status: 400,
        ...response,
      }),
    );

    await expect(generate(baseRequest())).rejects.toThrow(response.expected);
  });

  it.each([
    [{ "3": "invalid" }, "node 3"],
    [{ "4": { class_type: "Sampler" } }, "node 4 (Sampler)"],
    [{ "5": { errors: [{ message: " bad ", details: " seed " }] } }, "bad seed"],
    [{ "6": { errors: [{}] } }, "node 6"],
  ])("summarizes node validation errors %#", async (nodeErrors, expected) => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: false,
        status: 422,
        body: { node_errors: nodeErrors },
      }),
    );

    await expect(generate(baseRequest())).rejects.toThrow(expected);
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

  it.each([
    ["health", () => getHealth(), "ComfyUI health check"],
    ["config", () => getConfig(), "ComfyUI config fetch"],
    ["object info", () => getObjectInfo(), "object_info fetch"],
    ["sync", () => syncObjectInfo(), "object_info sync"],
  ])("%s surfaces HTTP failures", async (_name, request, operation) => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 502, text: "offline" }),
    );
    await expect(request()).rejects.toThrow(`${operation} failed (502): offline`);
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

  it("updateConfig surfaces HTTP failures", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 400, body: { message: "bad url" } }),
    );
    await expect(updateConfig("bad")).rejects.toThrow(
      /ComfyUI config update failed \(400\): bad url/,
    );
  });

  it("getObjectInfo and syncObjectInfo return JSON", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ body: { o: 1 } }))
      .mockResolvedValueOnce(makeResponse({ body: { synced: true, node_classes: 3 } }));

    expect(await getObjectInfo()).toEqual({ o: 1 });
    expect(await syncObjectInfo()).toEqual({ synced: true, node_classes: 3 });
  });

  it("throwRequestError handles an empty body (no detail suffix)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 404, text: "" }),
    );
    await expect(getObjectInfo()).rejects.toThrow(
      /object_info fetch failed \(404\)$/,
    );
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

  it("fetchOutputAsFile honors a supplied view URL", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ text: "data", blobType: "image/webp" }),
    );
    const file = await fetchOutputAsFile(
      "preview.webp",
      "ignored",
      "temp",
      "https://example.test/custom",
    );
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/custom");
    expect(file.type).toBe("image/webp");
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

  it("saves workflow content without optional object info", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ text: "" }));
    await saveWorkflowContent("plain", { nodes: [] });
    const [, options] = fetchMock.mock.calls[0];
    expect((options as RequestInit).body).not.toContain("object_info");
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

  it("preserves normalized workflow-rule response fields", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        body: {
          rules: { version: 1 },
          has_sidecar: true,
          warnings: [{ code: "warning" }],
        },
      }),
    );
    const result = await getWorkflowRules("wf");
    expect(result.has_sidecar).toBe(true);
    expect(result.warnings).toHaveLength(1);
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

  it("resolveWorkflowRules falls back through workflow, graph, and empty payloads", async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ body: {} }))
      .mockResolvedValueOnce(makeResponse({ body: { warnings: null } }))
      .mockResolvedValueOnce(makeResponse({ body: {} }));

    await resolveWorkflowRules({ workflow: { direct: true } });
    await resolveWorkflowRules({ workflow: null, graphData: { graph: true } });
    await resolveWorkflowRules({ workflow: null });

    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string),
    );
    expect(bodies[0]).toEqual({ workflow: { direct: true } });
    expect(bodies[1]).toEqual({
      workflow: { graph: true },
      graph_data: { graph: true },
    });
    expect(bodies[2]).toEqual({ workflow: {} });
  });

  it.each([
    ["list", () => listWorkflows(), "Workflow list fetch"],
    ["content", () => getWorkflowContent("wf"), "Workflow content fetch"],
    [
      "save",
      () => saveWorkflowContent("wf", {}),
      "Workflow save",
    ],
    ["upload", () => uploadWorkflowJsonFiles([]), "Workflow upload"],
    ["rules", () => getWorkflowRules("wf"), "Workflow rules fetch"],
    [
      "resolve",
      () => resolveWorkflowRules({ workflow: null }),
      "Workflow rules resolve",
    ],
  ])("%s workflow endpoint surfaces HTTP failures", async (
    _name,
    request,
    operation,
  ) => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 503, text: "unavailable" }),
    );
    await expect(request()).rejects.toThrow(
      `${operation} failed (503): unavailable`,
    );
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
