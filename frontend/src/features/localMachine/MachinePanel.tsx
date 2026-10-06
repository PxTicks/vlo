import { useState, useRef } from "react";
import { Alert, Box, Button, Dialog, DialogContent, DialogTitle, MenuItem, TextField, Typography } from "@mui/material";
import { localMachineEnabled, machineFetch, sharedRoots } from "./storage";
import { executeMachineCommand, machineCommandSchemas } from "./commands";
import { runMachineBrain } from "./brain";
import {activeEnabledPresets,ownerControls,shotFromControls,type LibraryPreset,type OwnerSchema} from "./library";

export function MachinePanel() {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(() => localStorage.getItem("vlo-machine-brain") || "gpt-6.1-sol");
  const [effort, setEffort] = useState(() => localStorage.getItem("vlo-machine-effort") || "low");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [library, setLibrary] = useState("");
  const [librarySession, setLibrarySession] = useState("");
  const [libraryId, setLibraryId] = useState("");
  const [libraryKind, setLibraryKind] = useState("preset");
  const [presets,setPresets] = useState<LibraryPreset[]>([]);
  const [ownerSchema,setOwnerSchema] = useState<OwnerSchema|null>(null);
  const [sourceHash,setSourceHash] = useState("");
  const [controlValues,setControlValues] = useState<Record<string,string>>({});
  const [nativeAudioAvailable,setNativeAudioAvailable] = useState(false);
  const selectionRevision = useRef(0);
  const effortOptions = model.startsWith("local:") ? ["low","medium","high","xhigh"] : model === "claude-opus-5-5" ? ["low","medium","high","xhigh","max"] : ["low","medium","high","xhigh","max","ultra"];
  if (!localMachineEnabled) return null;

  async function run() {
    setBusy(true);
    try {
      localStorage.setItem("vlo-machine-brain", model); localStorage.setItem("vlo-machine-effort", effort);
      const state = await executeMachineCommand("state", {});
      const commands = Object.keys(machineCommandSchemas).filter(key=>key!=="host.execute");
      const completed = await runMachineBrain([
        {role:"system",content:"You control the native VLO editor using only the supplied tools. Writes are confined to VLO's own media roots; shared Ruby/Comfy media are reference inputs. Only MiniMax H3 video and Qwen Image 2.1 are enabled. Ask for missing input before generation. A submitted job is not a completed render. Inspect state and use canonical ticks. Never invent workflow/input/asset IDs. Use real IDs returned by each tool before the next action. Return tool_calls for actions and continue from the tool results until the requested task is complete. Finish with a truthful user-facing result, including any failed actions. Do not call external APIs or built-in tools."},
        {role:"user",content:`Editor state: ${JSON.stringify(state)}\nRequest: ${prompt}`},
      ], commands, {
        complete: async messages => (await machineFetch("bridge/v1/chat/completions", {
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({model,reasoning_effort:effort,messages,tools:commands.map(key=>({type:"function",function:{name:key.replaceAll(".","_"),description:`Native VLO ${key}`,parameters:machineCommandSchemas[key]}}))}),
        })).json(),
        execute: executeMachineCommand,
      });
      setResult([completed.text,...completed.outcomes.map(outcome=>`${outcome.command}: ${JSON.stringify(outcome.error ? {error:outcome.error} : outcome.result)}`)].join("\n"));
    } catch (error) { setResult(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function readLibrary() {
    setBusy(true);
    try {
      const session = await (await machineFetch("bridge/library-use/sessions", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({project:"vlo"})})).json();
      const sessionId = session.library_use_id;
      if (!sessionId) throw new Error(`Library session unavailable: ${JSON.stringify(session)}`);
      setLibrarySession(sessionId);
      const catalogue = await (await machineFetch("library/presets")).json();
      setPresets(activeEnabledPresets(catalogue));
      setLibraryId("");setOwnerSchema(null);setSourceHash("");setControlValues({});selectionRevision.current++;
      setLibrary(`${catalogue.enabled_count} current Active presets are available for the enabled model registry. Select a card to read its native controls.`);
    } catch (error) {setLibrary(error instanceof Error ? error.message : String(error));} finally {setBusy(false);}
  }
  async function selectPreset(presetId:string) {
    const revision = ++selectionRevision.current;
    setLibraryId(presetId);setOwnerSchema(null);setSourceHash("");setControlValues({});
    if (!presetId) return;
    setBusy(true);
    try {
      const current = await (await machineFetch(`library/presets/${encodeURIComponent(presetId)}/schema`)).json();
      if (revision !== selectionRevision.current) return;
      const schema = {...current.schema,continuations:current.capability?.continuations} as OwnerSchema;
      if(!Array.isArray(schema.standard)||!Array.isArray(schema.advanced)) throw new Error("Ruby returned no native control schema");
      setOwnerSchema(schema);setSourceHash(current.entry.content_hash);
      setNativeAudioAvailable(current.capability?.model?.native_audio?.state === "supported");
      setControlValues(Object.fromEntries(ownerControls(schema).map(row=>[row.name,row.default == null ? "" : String(row.default)])));
    } catch(error) {setLibrary(error instanceof Error?error.message:String(error));} finally {setBusy(false);}
  }
  async function readSelection() {
    setBusy(true);
    try {
      if (!librarySession) throw new Error("Open the Active Library first");
      if (libraryKind === "preset") {
        if(!ownerSchema||!sourceHash) throw new Error("Refresh and select an Active preset to read its current controls");
        const imported = await (await machineFetch("library/workflow", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({preset_id:libraryId,ruby_project:"vlo",expected_source_hash:sourceHash,shot:shotFromControls(ownerSchema,controlValues)})})).json();
        setLibrarySession(imported.library_use_id);
        const outcome = await executeMachineCommand("generation.load", {workflow:imported.workflow_id});
        setLibrary(JSON.stringify({library:imported,native:outcome},null,2));
      } else {
        const receipt = await (await machineFetch(`bridge/library-use/${encodeURIComponent(librarySession)}/read`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requests:[libraryId.trim()],project:"vlo"})})).json();
        setLibrary(JSON.stringify(receipt,null,2));
      }
    } catch (error) {setLibrary(error instanceof Error ? error.message : String(error));} finally {setBusy(false);}
  }

  return <>
    <Button variant="contained" onClick={()=>setOpen(true)} sx={{position:"fixed",left:12,top:8,zIndex:2000}} size="small">Local brain & Ruby Library</Button>
    <Dialog open={open} onClose={()=>!busy&&setOpen(false)} fullWidth maxWidth="md">
      <DialogTitle>Local machine</DialogTitle>
      <DialogContent sx={{display:"grid",gap:2}}>
        <Typography variant="caption">Projects and exports: {sharedRoots.projects} · Temporary files: {sharedRoots.temp}</Typography>
        <Box sx={{display:"flex",gap:2}}>
          <TextField select label="Brain" value={model} onChange={e=>{setModel(e.target.value);setEffort("low");}} fullWidth>
            <MenuItem value="local:qwen3.8-27b@ninfer-ruby">Local Qwen 3.8 27B</MenuItem><MenuItem value="claude-opus-5-5">Opus 5.5 · Claude subscription</MenuItem><MenuItem value="gpt-6.1-sol">Sol 6.1 · Codex subscription</MenuItem>
          </TextField>
          <TextField select label="Effort" value={effortOptions.includes(effort)?effort:"low"} onChange={e=>setEffort(e.target.value)} fullWidth>{effortOptions.map(value=><MenuItem key={value} value={value}>{value}</MenuItem>)}</TextField>
        </Box>
        <Alert severity="info">Provider availability and Effort are checked by the local bridge. Generation and export status remain in the native editor.</Alert>
        <TextField label="Editor instruction" value={prompt} onChange={e=>setPrompt(e.target.value)} multiline minRows={3}/>
        <Button onClick={()=>void run()} disabled={busy||!prompt}>Run instruction</Button>
        {result&&<Typography component="pre" sx={{whiteSpace:"pre-wrap",maxHeight:240,overflow:"auto"}}>{result}</Typography>}
        <Button onClick={()=>void readLibrary()} disabled={busy}>Refresh Ruby Active Library</Button>
        <Box sx={{display:"flex",gap:1}}><TextField select label="Library action" value={libraryKind} onChange={e=>{setLibraryKind(e.target.value);setLibraryId("");setOwnerSchema(null);selectionRevision.current++;}}><MenuItem value="preset">Load Active preset</MenuItem><MenuItem value="request">Read Library resource</MenuItem></TextField>{libraryKind === "preset" ? <TextField select fullWidth label="Active H3 / Qwen Image 2.1 preset" value={libraryId} disabled={busy} onChange={e=>void selectPreset(e.target.value)}><MenuItem value="">Select a current preset</MenuItem>{presets.map(preset=><MenuItem key={preset.owner_id} value={preset.owner_id}>{preset.title} · {preset.owner_id}</MenuItem>)}</TextField> : <TextField label="Library request" helperText="Examples: index:kind=doc · toc:document-id · document-id#section · prompt:id · skill:id · cases:category/slug" value={libraryId} onChange={e=>setLibraryId(e.target.value)}/>}</Box>
        {libraryKind === "preset" && <>
          <Typography>{presets.find(preset=>preset.owner_id===libraryId)?.summary}</Typography>
          {ownerSchema?.continuations?.some(choice=>choice.possible) && <TextField select label="How to continue the source clip" value={controlValues["@extend_kind"]||""} onChange={e=>setControlValues(previous=>({...previous,"@extend_kind":e.target.value}))}><MenuItem value="">Select a native continuation</MenuItem>{ownerSchema.continuations.filter(choice=>choice.possible).map(choice=><MenuItem key={choice.id} value={choice.id}>{choice.label}</MenuItem>)}</TextField>}
          {ownerSchema && nativeAudioAvailable && <TextField select label="Additional speech / audio tracks" value={controlValues["@audio_enabled"]||""} helperText="Use the existing project policy or explicitly request additional tracks. Source clip context remains governed by the original card and preview." onChange={e=>setControlValues(previous=>({...previous,"@audio_enabled":e.target.value}))}><MenuItem value="">Use project policy</MenuItem><MenuItem value="false">Disable additional tracks for this import</MenuItem><MenuItem value="true">Enable additional tracks for this import</MenuItem></TextField>}
          {ownerSchema && ownerControls(ownerSchema).map(row=><Box key={row.name} sx={{display:"grid",gap:1}}><TextField label={row.label||row.name} required={row.required} value={controlValues[row.name]||""} helperText={row.help||row.why} type={["int","float","seed"].includes(row.type)?"number":"text"} multiline={row.type==="text"} slotProps={{htmlInput:{min:row.min,max:row.max,step:row.step}}} onChange={e=>setControlValues(previous=>({...previous,[row.name]:e.target.value}))}/>{row.bound_to === "shot_frames" && <TextField label="Moment in the new clip (seconds)" type="number" value={controlValues[`${row.name}:at_s`]||""} onChange={e=>setControlValues(previous=>({...previous,[`${row.name}:at_s`]:e.target.value}))}/>}</Box>)}
          {ownerSchema && <Alert severity="info">Select existing shared E media paths for clip and picture controls. Ruby previews and builds the current card with its own duration, reference and continuation rules. A changed or inactive card requires refresh and reimport before a new generation.</Alert>}
        </>}
        <Button onClick={()=>void readSelection()} disabled={busy||!libraryId.trim()||(libraryKind==="preset"&&!ownerSchema)}>{libraryKind==="preset"?"Bind current card and load native workflow":"Read with receipt"}</Button>
        {library&&<Typography component="pre" sx={{whiteSpace:"pre-wrap",maxHeight:260,overflow:"auto"}}>{library}</Typography>}
      </DialogContent>
    </Dialog>
  </>;
}
