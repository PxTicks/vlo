import type { Processor, ProcessorDescription } from "./types";

/**
 * Runs an ordered list of processors against a shared context.
 *
 * Each processor checks its own activation condition via `isActive()`.
 * If active, its `execute()` is called — it reads from and writes to the context.
 * Processors run sequentially in the order provided.
 */
export async function runProcessors<TContext>(
  processors: readonly Processor<TContext>[],
  context: TContext,
): Promise<void> {
  for (const processor of processors) {
    if (!processor.isActive(context)) {
      continue;
    }
    await processor.execute(context);
  }
}

/**
 * Describes which processors would run for a given context, without executing them.
 *
 * Returns metadata for every processor in the list, with an `active` flag
 * indicating whether it would run. Useful for debugging, logging, and
 * transparency about the pipeline's behavior for a particular workflow+rules.
 */
export function describeProcessors<TContext>(
  processors: readonly Processor<TContext>[],
  context: TContext,
): ProcessorDescription[] {
  return processors.map((processor) => ({
    name: processor.meta.name,
    description: processor.meta.description,
    reads: processor.meta.reads,
    writes: processor.meta.writes,
    active: processor.isActive(context),
  }));
}
