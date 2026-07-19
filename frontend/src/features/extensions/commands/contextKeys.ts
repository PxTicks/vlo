/**
 * Context keys are shell infrastructure (extension-shell-surfaces plan
 * §3.10); this module remains as a re-export for existing imports.
 */
export {
  HostContextKeyService,
  assertContextKeyExpression,
  evaluateContextKeyExpression,
  hostContextKeys,
} from "../../../core/shell/contextKeys";
