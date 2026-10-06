import { describe, expect, it } from "vitest";
import { matchImportedApiWorkflow } from "../../../../../backend/assets/comfyui_bridge/bridge-core.mjs";

describe("native ComfyUI API graph import confirmation", () => {
  const graph = {"1":{class_type:"CLIPTextEncode",inputs:{text:"owner prompt",clip:["2",0]},_meta:{title:"Owner title"}},"2":{class_type:"CLIPLoader",inputs:{clip_name:"qwen_2.1.safetensors"}}};
  it("compares native executable values while allowing visual metadata conversion", () => {
    expect(matchImportedApiWorkflow(graph,{"2":{inputs:{clip_name:"qwen_2.1.safetensors"},class_type:"CLIPLoader"},"1":{inputs:{clip:["2",0],text:"owner prompt"},class_type:"CLIPTextEncode"}})).toBe(true);
  });
  it("rejects altered prompts, absent nodes and extra execution nodes", () => {
    expect(matchImportedApiWorkflow(graph,{...graph,"1":{...graph["1"],inputs:{...graph["1"].inputs,text:"changed"}}})).toBe(false);
    expect(matchImportedApiWorkflow(graph,{"1":graph["1"]})).toBe(false);
    expect(matchImportedApiWorkflow(graph,{...graph,"3":graph["2"]})).toBe(false);
    expect(matchImportedApiWorkflow(graph,{nodes:[]})).toBe(false);
  });
  it("requires exact numeric execution values, including owner float precision", () => {
    const owner = {"4":{class_type:"ModelSamplingFlux",inputs:{max_shift:0.693548}}};
    expect(matchImportedApiWorkflow(owner,{"4":{class_type:"ModelSamplingFlux",inputs:{max_shift:0.69}}})).toBe(false);
    expect(matchImportedApiWorkflow(owner,owner)).toBe(true);
  });
});
