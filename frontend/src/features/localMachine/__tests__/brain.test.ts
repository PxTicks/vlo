import { describe, expect, it, vi } from "vitest";
import { runMachineBrain, type MachineBrainMessage } from "../brain";

describe("native brain tool-result loop", () => {
  it("creates a project and uses the actual imported asset ID for native timeline insertion", async () => {
    let rounds = 0;
    const execute = vi.fn(async (command: string, args: unknown) => {
      if (command === "project.create") return {id:"native-project-42",title:"Film"};
      if (command === "assets.import") return {assetId:"native-asset-42",name:"reference.png"};
      return {inserted:(args as {assetId:string}).assetId};
    });
    const complete = vi.fn(async (messages: readonly MachineBrainMessage[]) => {
      rounds += 1;
      if (rounds === 1) return {choices:[{message:{tool_calls:[{id:"call-create",type:"function" as const,function:{name:"project_create",arguments:JSON.stringify({title:"Film"})}}]}}]};
      if (rounds === 2) {
        const actual = messages.find(message=>message.role==="tool"&&message.tool_call_id==="call-create");
        expect(JSON.parse(actual!.content!).result.id).toBe("native-project-42");
        return {choices:[{message:{tool_calls:[{id:"call-import",type:"function" as const,function:{name:"assets_import",arguments:JSON.stringify({root:"reference",path:"reference.png"})}}]}}]};
      }
      if (rounds === 3) {
        const actual = messages.find(message=>message.role==="tool"&&message.tool_call_id==="call-import");
        return {choices:[{message:{tool_calls:[{id:"call-insert",type:"function" as const,function:{name:"timeline_insert",arguments:JSON.stringify({assetId:JSON.parse(actual!.content!).result.assetId,startTick:0})}}]}}]};
      }
      expect(messages.find(message=>message.tool_call_id==="call-insert")?.content).toContain('"inserted":"native-asset-42"');
      return {choices:[{message:{content:"Created Film, imported the reference and inserted it."}}]};
    });
    const result = await runMachineBrain([{role:"user",content:"Create, import then insert"}], ["project.create","assets.import","timeline.insert"], {complete,execute});
    expect(complete).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenNthCalledWith(3,"timeline.insert",{assetId:"native-asset-42",startTick:0});
    expect(result.text).toBe("Created Film, imported the reference and inserted it.");
  });
  it("feeds native failures back so the brain cannot observe a false successful tool", async () => {
    const complete = vi.fn().mockResolvedValueOnce({choices:[{message:{tool_calls:[{id:"failed",type:"function",function:{name:"export_start",arguments:"{}"}}]}}]}).mockImplementationOnce(async (messages: MachineBrainMessage[])=>{
      expect(JSON.parse(messages.at(-1)!.content!)).toEqual({ok:false,error:"Native renderer busy"});
      return {choices:[{message:{content:"Export could not start: renderer busy."}}]};
    });
    const result = await runMachineBrain([{role:"user",content:"Export"}], ["export.start"], {complete,execute:async()=>{throw new Error("Native renderer busy");}});
    expect(result.outcomes).toEqual([{command:"export.start",error:"Native renderer busy"}]);
  });
  it("fails explicitly when a brain never reaches a final decision", async () => {
    let sequence=0;
    const complete = async()=>({choices:[{message:{tool_calls:[{id:`call-${++sequence}`,type:"function" as const,function:{name:"state",arguments:"{}"}}]}}]});
    await expect(runMachineBrain([{role:"user",content:"state"}],["state"],{complete,execute:async()=>({})},2)).rejects.toThrow("reached 2 brain rounds");
  });
  it("never dispatches a provider built-in or unrecognized tool", async () => {
    const execute=vi.fn();
    await expect(runMachineBrain([{role:"user",content:"instruction"}],["state"],{complete:async()=>({choices:[{message:{tool_calls:[{id:"x",type:"function",function:{name:"shell",arguments:'{"command":"delete"}'}}]}}]}),execute})).rejects.toThrow("unsupported");
    expect(execute).not.toHaveBeenCalled();
  });
});
