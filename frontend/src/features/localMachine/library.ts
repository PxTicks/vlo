export interface LibraryPreset { owner_id:string;title:string;summary:string;revision:number;content_hash:string;detail:{model_family?:string;machine_family?:string};state:string }
export interface OwnerControl {name:string;type:string;label?:string;help?:string;why?:string;bound_to?:string;required?:boolean;default?:unknown;min?:number;max?:number;step?:number;state?:string;options?:unknown[]}
export interface OwnerSchema {standard:OwnerControl[];advanced:OwnerControl[];continuations?:Array<{id:string;label:string;possible:boolean}>}
export function activeEnabledPresets(value: unknown): LibraryPreset[] {
  if (!value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) throw new Error("Ruby catalogue returned no entries");
  return value.entries.filter((row):row is LibraryPreset => row?.state === "active" && typeof row.owner_id === "string" && typeof row.detail?.machine_family === "string");
}
export function ownerControls(schema: OwnerSchema): OwnerControl[] {
  return [...schema.standard,...schema.advanced].filter(row=>row.bound_to !== "shot_frame_positions" && row.state !== "unsupported");
}
export function shotFromControls(schema:OwnerSchema,values:Record<string,string>):Record<string,unknown> {
  const shot:Record<string,unknown> = {model:"comfyui"};
  const advanced:Record<string,unknown> = {};
  const references:string[] = [];
  const shotFrames:Array<{path:string;at_s:number}> = [];
  for (const row of ownerControls(schema)) {
    const text = values[row.name]?.trim() ?? "";
    if (!text) {if(row.required) throw new Error(`${row.label || row.name} is required`); continue;}
    let value:unknown = text;
    if (["int","float","seed"].includes(row.type)) {
      value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`${row.label || row.name} needs a number`);
    } else if (row.type === "bool") value = text === "true";
    const role = row.bound_to;
    if (role === "references") references.push(text);
    else if (role === "shot_frames") {
      const at = Number(values[`${row.name}:at_s`]);
      if (!values[`${row.name}:at_s`]?.trim() || !Number.isFinite(at) || at < 0) throw new Error(`${row.label || row.name} needs its moment in seconds`);
      shotFrames.push({path:text,at_s:at});
    } else if (role) shot[role] = value;
    else advanced[row.name] = value;
  }
  if(references.length) shot.references = references;
  if(shotFrames.length) shot.shot_frames = shotFrames;
  if(Object.keys(advanced).length) shot.advanced = advanced;
  if(shot.extend_from) {
    const selected = values["@extend_kind"];
    if(!schema.continuations?.some(choice=>choice.possible && choice.id===selected)) throw new Error("Choose an available native continuation kind");
    shot.mode="extend";shot.extend_kind=selected;
  }
  if(values["@audio_enabled"] === "false") shot.audio_enabled = false;
  if(values["@audio_enabled"] === "true") shot.audio_enabled = true;
  return shot;
}
