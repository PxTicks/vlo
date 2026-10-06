import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeMachineCommand } from "../commands";
import { useProjectStore } from "../../project/useProjectStore";
import { fileSystemService } from "../../project/services/FileSystemService";
import { machineDirectory } from "../storage";
import { getTimelineSnapshot } from "../../timeline";
import { useGenerationStore } from "../../generation";

describe("native local-machine command dispatch", () => {
  beforeEach(() => { useProjectStore.setState({project:null,rootHandle:null}); });
  afterEach(() => vi.unstubAllGlobals());
  it("returns real native state", async () => {
    const state = await executeMachineCommand("state", {}) as {project: unknown;timeline:unknown};
    expect(state.project).toBeNull();
    expect(state.timeline).toEqual(getTimelineSnapshot());
  });
  it("refuses unknown commands and invalid paths before creating native projects", async () => {
    await expect(executeMachineCommand("arbitrary.shell", {})).rejects.toThrow("Unknown");
    await expect(executeMachineCommand("project.create", {title:"../outside"})).rejects.toThrow();
    expect(useProjectStore.getState().project).toBeNull();
  });
  it("refuses native timeline mutation when no project is open", async () => {
    const previous = getTimelineSnapshot();
    await expect(executeMachineCommand("timeline.remove", {clipIds:["missing"]})).rejects.toThrow("Open or create");
    expect(getTimelineSnapshot()).toEqual(previous);
  });
  it("does not acknowledge unknown clips as edited", async () => {
    const handle = machineDirectory("projects", "Fixture");
    fileSystemService.setHandle(handle);
    useProjectStore.setState({rootHandle:handle,timelineSnapshotRequest:null});
    await expect(executeMachineCommand("timeline.split", {clipId:"missing",splitTick:100})).rejects.toThrow("existing clip");
  });
  it("blocks an excluded workflow before invoking the native loader", async () => {
    useProjectStore.setState({rootHandle:machineDirectory("projects","Fixture")});
    const previous = useGenerationStore.getState().selectedWorkflowId;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({workflow_prefixes:["vlo_minimax_h3_","vlo_qwen_image_2_1_"]}), {headers:{"content-type":"application/json"}})));
    await expect(executeMachineCommand("generation.load",{workflow:"vlo_ltx2_5.json"})).rejects.toThrow("outside the enabled");
    expect(useGenerationStore.getState().selectedWorkflowId).toBe(previous);
  });
});
