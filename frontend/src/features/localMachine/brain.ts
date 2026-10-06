/** Subscription/local brain orchestration over acknowledged native host tools. */
export interface MachineToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface MachineBrainMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: MachineToolCall[];
  tool_call_id?: string;
}
interface BrainResponse {
  choices?: Array<{message?: {content?: string | null; tool_calls?: MachineToolCall[]}}>;
}
export interface MachineBrainDependencies {
  complete(messages: readonly MachineBrainMessage[]): Promise<BrainResponse>;
  execute(command: string, args: unknown): Promise<unknown>;
}

/** A bounded decision loop; the model receives every actual native result.
 * It never receives shell execution or provider built-in tools. */
export async function runMachineBrain(
  initial: readonly MachineBrainMessage[],
  commandNames: readonly string[],
  dependencies: MachineBrainDependencies,
  maximumRounds = 12,
): Promise<{text: string; outcomes: Array<{command: string; result?: unknown; error?: string}>}> {
  const messages: MachineBrainMessage[] = [...initial];
  const outcomes: Array<{command: string; result?: unknown; error?: string}> = [];
  const observedCallIds = new Set<string>();
  for (let round = 0; round < maximumRounds; round += 1) {
    const response = await dependencies.complete(messages);
    const decision = response.choices?.[0]?.message;
    if (!decision) throw new Error("Brain returned no assistant decision");
    const calls = decision.tool_calls || [];
    if (!Array.isArray(calls) || calls.length > 32) throw new Error("Brain returned an invalid tool batch");
    if (calls.length === 0) {
      if (typeof decision.content !== "string" || !decision.content.trim()) throw new Error("Brain returned no final message");
      return {text:decision.content, outcomes};
    }
    if (outcomes.length + calls.length > 64) throw new Error("Instruction reached the native tool limit; inspect the saved editor state before continuing");
    messages.push({role:"assistant",content:decision.content || null,tool_calls:calls});
    for (const call of calls) {
      if (call.type !== "function" || !call.id || observedCallIds.has(call.id)) throw new Error("Brain returned an invalid or repeated tool call ID");
      observedCallIds.add(call.id);
      const command = commandNames.find(name => name.replaceAll(".","_") === call.function?.name);
      if (!command) throw new Error("Brain requested an unsupported native editor tool");
      let result: unknown;
      try {
        const args = JSON.parse(call.function.arguments);
        result = await dependencies.execute(command, args);
        outcomes.push({command,result});
        messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify({ok:true,result})});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcomes.push({command,error:message});
        messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify({ok:false,error:message})});
      }
    }
  }
  throw new Error(`Instruction reached ${maximumRounds} brain rounds; completed changes remain in the native editor. Inspect state before continuing.`);
}
