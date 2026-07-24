import { useEffect, useState } from "react";
import {
  assertMenuTreeDefinition,
  type MenuTreeDefinition,
} from "../../../core/shell/menuTree";
import { getWorkflowMenuDefinition } from "../services/comfyuiApi";
import { DEFAULT_GENERATION_WORKFLOW_MENU } from "../workflowMenu";

export function useWorkflowMenuDefinition(): MenuTreeDefinition {
  const [definition, setDefinition] = useState<MenuTreeDefinition>(
    DEFAULT_GENERATION_WORKFLOW_MENU,
  );

  useEffect(() => {
    const abortController = new AbortController();
    void getWorkflowMenuDefinition(abortController.signal)
      .then((candidate) => {
        assertMenuTreeDefinition(candidate);
        setDefinition(candidate);
      })
      .catch((reason: unknown) => {
        if (!abortController.signal.aborted) {
          console.warn(
            "[Generation] Falling back to the packaged workflow menu:",
            reason,
          );
        }
      });
    return () => abortController.abort();
  }, []);

  return definition;
}
