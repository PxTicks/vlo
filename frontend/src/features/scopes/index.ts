export { ScopesView } from "./ScopesView";
export { registerHostScopes, analyzeScopeFrame } from "./hostScopes";
export {
  hostScopeRegistry,
  HostScopeRegistry,
  MAX_SCOPE_SURFACE_PX,
  MIN_SCOPE_SURFACE_PX,
  type ScopeDefinition,
  type ScopeEntry,
  type ScopeFrameSample,
  type ScopeRegistration,
  type ScopeRenderTarget,
} from "./scopeRegistry";
export { analyzeScopePixels, type ScopeSnapshot } from "./scopeAnalysis";
