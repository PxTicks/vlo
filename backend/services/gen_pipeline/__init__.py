"""Generation pipeline infrastructure.

Provides the processor model, typed context, and runner for both
frontend and backend generation pipelines.

Processors are self-documenting functions with metadata that declare
their inputs, outputs, and activation conditions.  The runner iterates
an ordered list of processors, calling each one's ``execute()`` method
on a shared context object.
"""

from services.gen_pipeline.context import BackendPipelineContext
from services.gen_pipeline.runner import describe_processors, run_processors
from services.gen_pipeline.types import Processor, ProcessorDescription, ProcessorMeta

__all__ = [
    "BackendPipelineContext",
    "Processor",
    "ProcessorDescription",
    "ProcessorMeta",
    "describe_processors",
    "run_processors",
]
