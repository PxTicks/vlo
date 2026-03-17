import * as comfyApi from "../services/comfyuiApi";
import { parseHistoryOutputs } from "../services/parsers";
import type { GenerationJobOutput } from "../types";

const HISTORY_FETCH_ATTEMPTS = 4;
const HISTORY_FETCH_RETRY_MS = 250;

export async function getHistoryOutputsWithRetry(
  promptId: string,
): Promise<GenerationJobOutput[]> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < HISTORY_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const history = await comfyApi.getHistory(promptId);
      const { hasPromptEntry, outputs } = parseHistoryOutputs(history, promptId);
      if (hasPromptEntry || outputs.length > 0) {
        return outputs;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < HISTORY_FETCH_ATTEMPTS - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, HISTORY_FETCH_RETRY_MS),
      );
    }
  }

  if (lastError) throw lastError;
  return [];
}
