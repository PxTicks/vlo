import {describe,it,expect} from "vitest";
import {activeEnabledPresets,shotFromControls} from "../library";
describe("fresh native Ruby Library controls",()=>{
  it("reads current Active entries, includes future H3 cards and excludes other model families",()=>{
    const row={title:"Owner",summary:"description",revision:7,content_hash:"hash",state:"active"};
    expect(activeEnabledPresets({entries:[{...row,owner_id:"new_extend",detail:{machine_family:"minimax_h3"}},{...row,owner_id:"new_owner_picture_card",detail:{machine_family:"qwen_image_2_1"}},{...row,state:"inactive",owner_id:"hidden",detail:{machine_family:"minimax_h3"}},{...row,owner_id:"wan",detail:{model_family:"wan"}}]}).map(x=>x.owner_id)).toEqual(["new_extend","new_owner_picture_card"]);
  });
  it("derives source, duration, references and moment controls from owner roles without preset ID branches",()=>{
    const schema={standard:[{name:"clip",type:"video_asset",required:true,bound_to:"extend_from"},{name:"new_seconds",type:"float",bound_to:"duration_s"},{name:"portrait",type:"image_asset",bound_to:"references"},{name:"middle",type:"image_asset",bound_to:"shot_frames"}],advanced:[],continuations:[{id:"motion",label:"Owner motion",possible:true}]};
    expect(shotFromControls(schema,{clip:"E:/Media/VLO/Project/clip.mp4",new_seconds:"5.5",portrait:"E:/Media/Rubyapp/KeyAsset/id.png",middle:"E:/Media/VLO/Project/frame.png","middle:at_s":"2","@extend_kind":"motion"})).toEqual({model:"comfyui",extend_from:"E:/Media/VLO/Project/clip.mp4",duration_s:5.5,references:["E:/Media/Rubyapp/KeyAsset/id.png"],shot_frames:[{path:"E:/Media/VLO/Project/frame.png",at_s:2}],mode:"extend",extend_kind:"motion"});
    expect(()=>shotFromControls(schema,{})).toThrow("required");
  });
  it("retains an explicit disabled additional audio choice and refuses a withheld continuation",()=>{
    const schema={standard:[{name:"clip",type:"video_asset",bound_to:"extend_from"}],advanced:[],continuations:[{id:"picture",label:"Owner picture",possible:true},{id:"motion",label:"Owner motion",possible:false}]};
    expect(shotFromControls(schema,{clip:"E:/Media/VLO/Project/clip.mp4","@extend_kind":"picture","@audio_enabled":"false"})).toMatchObject({extend_kind:"picture",audio_enabled:false});
    expect(()=>shotFromControls(schema,{clip:"E:/Media/VLO/Project/clip.mp4","@extend_kind":"motion"})).toThrow("continuation");
  });
});
