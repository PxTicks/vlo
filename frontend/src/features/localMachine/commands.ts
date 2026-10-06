import { z } from "zod";
import { useProjectStore } from "../project/useProjectStore";
import type { ProjectConfig } from "../project/useProjectStore";
import { getAssets, getAssetById, addLocalAsset, ensureAssetFileLoaded } from "../userAssets";
import { getTimelineSnapshot, insertTimelineAssetAtTime, removeTimelineClips, splitTimelineClip, moveTimelineClips, flushPendingTimelinePersistence, getTimelineClipById } from "../timeline";
import { useGenerationStore } from "../generation";
import { generationSessionService } from "../generation/services/GenerationSessionService";
import type { SlotValue } from "../generation/pipeline/types";
import { getHostExportController } from "../../core/export/exportController";
import { getLatestExportRun } from "../../core/export/exportRunLog";
import { hostCommandTable } from "../../core/shell/commandTable";
import { machineDirectory, machineFetch } from "./storage";

const name = z.string().min(1).max(200).refine(v => !/[\\/:]/.test(v) && v !== "." && v !== "..", "Use a folder name within the shared workspace");
const tick = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(200);
const strings = z.record(z.string(), z.string());
const config = z.object({fps: z.number().int().min(1).max(240).optional(), aspectRatio: z.string().regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/).optional(), outputResolution: z.number().int().min(2).max(8192).refine(n => n % 2 === 0).optional(), fitMode: z.enum(["contain", "cover"]).optional()}).strict();
const schemas = {
  "state": z.object({}).strict(),
  "project.create": z.object({ title: name, config: config.optional() }).strict(),
  "project.open": z.object({ folder: name }).strict(),
  "project.save": z.object({}).strict(),
  "project.configure": config,
  "assets.import": z.object({ root: z.enum(["projects", "reference", "temp", "rubyapp"]), path: z.string().min(1) }).strict(),
  "timeline.insert": z.object({ assetId: id, startTick: tick }).strict(),
  "timeline.remove": z.object({ clipIds: z.array(id).min(1).max(1000) }).strict(),
  "timeline.split": z.object({ clipId: id, splitTick: tick }).strict(),
  "timeline.move": z.object({ moves: z.array(z.object({clipId: id, start: tick, trackId: id.optional()}).strict()).min(1).max(1000) }).strict(),
  "generation.load": z.object({ workflow: id }).strict(),
  "generation.configure": z.object({textValues: strings.optional(), widgetValues: strings.optional(), media: strings.optional()}).strict(),
  "generation.start": z.object({ texts: strings.optional(), widgets: strings.optional(), media: z.record(z.string(), z.object({assetId: id, type: z.enum(["image", "audio", "video"])}).strict()).optional() }).strict(),
  "generation.cancel": z.object({}).strict(),
  "export.start": z.object({startTicks: tick, endTicks: tick, format: z.enum(["mp4", "webm"]).default("mp4"), formatId: id.default("machine.export"), fps: z.number().int().min(1).max(120).optional()}).strict(),
  "export.status": z.object({}).strict(),
  "export.cancel": z.object({}).strict(),
  "host.execute": z.object({ commandId: id, subject: z.json().optional() }).strict(),
};
export const machineCommandSchemas = Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [key, z.toJSONSchema(schema)]));

function requireProject() { if (!useProjectStore.getState().rootHandle) throw new Error("Open or create a project first"); }
async function save() {
  await flushPendingTimelinePersistence();
  if (!await useProjectStore.getState().saveProject()) throw new Error("Native project persistence failed");
}
async function requireTimelineReady() {
  requireProject();
  const deadline = Date.now() + 30000;
  while (useProjectStore.getState().timelineSnapshotRequest) {
    if (Date.now() >= deadline) throw new Error("Native editor has not finished loading the timeline");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
export async function executeMachineCommand(command: string, args: unknown): Promise<unknown> {
  const schema = schemas[command as keyof typeof schemas];
  if (!schema) throw new Error(`Unknown machine command: ${command}`);
  const data = schema.parse(args) as Record<string, unknown>;
  if (command === "state") return { project: useProjectStore.getState().project, config: useProjectStore.getState().config, assets: getAssets().map(a => ({id:a.id, name:a.name, type:a.type})), timeline: getTimelineSnapshot(), generation: {workflowId:useGenerationStore.getState().selectedWorkflowId, inputs: useGenerationStore.getState().workflowInputs, jobs: [...useGenerationStore.getState().jobs.values()]}, export: getLatestExportRun(), schemas: machineCommandSchemas };
  if (command === "project.create") { const p = schemas["project.create"].parse(args); await useProjectStore.getState().createProject(p.title, machineDirectory(), p.config as Partial<ProjectConfig>); return useProjectStore.getState().project; }
  if (command === "project.open") { await useProjectStore.getState().loadProject(await machineDirectory().getDirectoryHandle(String(data.folder))); return useProjectStore.getState().project; }
  requireProject();
  if (command === "project.save") { await save(); return {saved:true}; }
  if (command === "project.configure") { const p = schemas["project.configure"].parse(args); await useProjectStore.getState().updateConfig(p as Partial<ProjectConfig>); const actual = useProjectStore.getState().config; for (const [key,value] of Object.entries(p)) if (actual[key as keyof typeof actual] !== value) throw new Error("Project geometry rejected the requested config"); return actual; }
  if (command === "assets.import") {
    const path = String(data.path); const parts = path.split("/"); const filename = parts.pop()!;
    const file = await (await machineFetch(`fs/file?${new URLSearchParams({root:String(data.root),path})}`)).blob();
    const asset = await addLocalAsset(new File([file], filename, {type:file.type}));
    if (!asset) throw new Error("Native asset importer rejected the file");
    await save(); return {assetId:asset.id, name:asset.name};
  }
  if (command.startsWith("timeline.")) {
    await requireTimelineReady();
    if (command === "timeline.insert") { const a = getAssetById(String(data.assetId)); if (!a) throw new Error("Asset not found"); const before = getTimelineSnapshot().clips.length; insertTimelineAssetAtTime(a, Number(data.startTick)); if(getTimelineSnapshot().clips.length <= before) throw new Error("Native timeline did not insert the asset"); }
    if (command === "timeline.remove") { const ids = data.clipIds as string[]; if (ids.some(clipId => !getTimelineClipById(clipId))) throw new Error("Clip not found"); if (!removeTimelineClips(ids)) throw new Error("Timeline refused removal"); }
    if (command === "timeline.split") { const clip = getTimelineClipById(String(data.clipId)); const split = Number(data.splitTick); if (!clip || split <= clip.start || split >= clip.start + clip.timelineDuration) throw new Error("Split must be inside an existing clip"); splitTimelineClip(clip.id, split); }
    if (command === "timeline.move") { const moves = schemas["timeline.move"].parse(args).moves; if (moves.some(m => !getTimelineClipById(m.clipId)) || !moveTimelineClips(moves)) throw new Error("Timeline refused movement"); }
    await save(); return getTimelineSnapshot();
  }
  if (command === "generation.load") {
    const capabilities = await (await machineFetch("capabilities")).json() as {workflow_prefixes: string[]};
    if (!capabilities.workflow_prefixes.some(prefix => String(data.workflow).startsWith(prefix))) throw new Error("This workflow is outside the enabled local model registry");
    await useGenerationStore.getState().loadWorkflow(String(data.workflow));
    const deadline = Date.now() + 45000;
    while (!useGenerationStore.getState().isWorkflowReady) {
      const state = useGenerationStore.getState();
      if (state.workflowLoadState === "error") throw new Error(state.workflowLoadError || "Native workflow load failed");
      if (Date.now() >= deadline) throw new Error("ComfyUI has not confirmed this native workflow; inspect its connection/missing nodes");
      await new Promise(resolve => setTimeout(resolve,100));
    }
    const loaded = useGenerationStore.getState();
    if (loaded.selectedWorkflowId !== data.workflow) throw new Error("Another workflow replaced the requested native workflow");
    return {workflow:loaded.selectedWorkflowId, inputs:loaded.workflowInputs, warnings:loaded.workflowWarning};
  }
  if (command === "generation.configure") {
    const p = schemas["generation.configure"].parse(args);
    const outcome = generationSessionService.transaction("Local machine generation inputs", tx => {
      for (const [inputId,value] of Object.entries(p.textValues || {})) tx.setTextInput(inputId,value);
      for (const [key,value] of Object.entries(p.widgetValues || {})) { const divider = key.lastIndexOf(":"); if (divider < 1) throw new Error("Widgets use nodeId:param addresses from native state"); tx.setWidget({nodeId:key.slice(0,divider),widget:key.slice(divider+1)},value); }
      for (const [inputId,assetId] of Object.entries(p.media || {})) tx.attachAsset(inputId,assetId);
    });
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    await new Promise(resolve => setTimeout(resolve,50));
    await save(); return generationSessionService.getSnapshot();
  }
  if (command === "generation.start") {
    const p = schemas["generation.start"].parse(args); const slots: Record<string,SlotValue> = {};
    const state = useGenerationStore.getState();
    if (!state.isWorkflowReady) throw new Error("Native workflow is not ready");
    if (state.selectedWorkflowId?.includes("_ruby_")) await machineFetch(`library/workflows/${encodeURIComponent(state.selectedWorkflowId)}/validate`);
    const knownInputs = new Set(state.workflowInputs.map(input => input.id));
    if ([...Object.keys(p.texts || {}),...Object.keys(p.media || {})].some(key => !knownInputs.has(key))) throw new Error("Generation input ID is absent from the native workflow");
    for (const [key,value] of Object.entries(p.texts || {})) slots[key] = {type:"text",value};
    for (const [key,media] of Object.entries(p.media || {})) { const file = await ensureAssetFileLoaded(media.assetId); if (!file) throw new Error(`Asset file unavailable: ${media.assetId}`); slots[key] = {type:media.type,file}; }
    const promptId = await useGenerationStore.getState().submitGeneration(slots, p.widgets);
    if (!promptId) throw new Error("Native generation submission failed; inspect missing models/nodes and slots");
    return {promptId, status:"submitted"};
  }
  if (command === "generation.cancel") { await useGenerationStore.getState().cancelGeneration(); return {cancelled:true}; }
  if (command === "export.status") return getLatestExportRun();
  if (command.startsWith("export.")) {
    await requireTimelineReady(); const controller = getHostExportController(); if (!controller) throw new Error("Native export controller is unavailable");
    if (command === "export.cancel") { controller.cancel(); return {cancelRequested:true}; }
    const p = schemas["export.start"].parse(args); if (p.endTicks <= p.startTicks) throw new Error("Export end must exceed start"); if (!controller.canStart()) throw new Error("Native renderer is busy"); return {runId:controller.startRange(p), status:"started", destination:"native project asset library; inspect export.status for completion"};
  }
  if (command === "host.execute") {
    const p = schemas["host.execute"].parse(args); const entry = hostCommandTable.getEntry(p.commandId);
    if (!entry || entry.source !== "host" || !entry.allowExtensionExecute || !hostCommandTable.isEnabled(p.commandId)) throw new Error("Host command is unavailable or not approved for programmatic execution");
    await entry.run({source:"api", subject:p.subject}); await save(); return {executed:p.commandId};
  }
  throw new Error("Command handler unavailable");
}

export function installMachineCommandTransport() {
  const session = crypto.randomUUID(); let disposed = false; let timer: ReturnType<typeof setTimeout>;
  async function poll() {
    try {
      await machineFetch("editor/heartbeat", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session})});
      const job = await (await machineFetch(`editor/next?${new URLSearchParams({session})}`)).json();
      if (job && !disposed) {
        let result: unknown = null; let error: string | null = null;
        try { result = await executeMachineCommand(job.command, job.args); } catch (e) { error = e instanceof Error ? e.message : String(e); }
        await machineFetch("editor/result", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session,id:job.id,result,error})});
      }
    } catch (error) { console.warn("Local editor automation:", error); }
    if (!disposed) timer = setTimeout(() => void poll(), 1000);
  }
  // A separate lease renewal keeps long imports/exports from losing authority.
  const heartbeat = setInterval(() => { if (!disposed) void machineFetch("editor/heartbeat", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session})}).catch(() => undefined); }, 5000);
  void poll();
  return () => {disposed = true; clearTimeout(timer); clearInterval(heartbeat);};
}
