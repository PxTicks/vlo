export const BRIDGE_PROTOCOL: string;
export const BRIDGE_VERSION: number;
export const BRIDGE_CAPABILITIES: readonly string[];

export function fingerprintWorkflow(graphData: unknown): string | null;
export function matchImportedApiWorkflow(expected: unknown, actual: unknown): boolean;

export interface DroppedSubgraphLink {
  subgraphId: string | null;
  subgraphName: string | null;
  linkId: unknown;
  targetNodeId: string;
  inputName: string;
}

export function matchInjectedWorkflow(
  expected: unknown,
  actual: unknown,
): DroppedSubgraphLink[] | null;

export function startVloBridge(options: {
  app: unknown;
  api: unknown;
  windowObject?: unknown;
}): { stop(): void; readActive(): unknown } | null;
