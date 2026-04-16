from __future__ import annotations

from collections import defaultdict
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


WidgetsMode = Literal["control_after_generate", "all"]
DerivedWidgetKind = Literal["dual_sampler_denoise", "video_audio_retake"]
VideoAudioRetakeMode = Literal["Video & Audio", "Video", "Audio"]
WidgetControl = Literal["slider"]
WidgetSliderDisplay = Literal["percent", "number"]
MaskCroppingMode = Literal["crop", "full"]
MaskSourceVideoTreatment = Literal[
    "preserve_transparency",
    "fill_transparent_with_neutral_gray",
    "remove_transparency",
]
PipelineComparisonOperator = Literal["eq", "neq", "lt", "lte", "gt", "gte"]
PipelineStageKind = Literal["mask_processing", "aspect_ratio", "output_assembly"]
PipelineControlExposure = Literal["widget", "none"]
PipelineControlSource = Literal["client", "backend"]
PipelineControlValueType = Literal["int", "float", "string", "boolean", "enum", "unknown"]
MaskProcessingTargetType = Literal["binary", "soft"]
MaskProcessingTargetPurpose = Literal["video", "audio_timing"]
PostprocessingMode = Literal["auto", "stitch_frames_with_audio", "none"]
PostprocessingPanelPreview = Literal["raw_outputs", "replace_outputs"]
PostprocessingOnFailure = Literal["fallback_raw", "show_error"]
AspectRatioPostprocessMode = Literal["stretch_exact"]
AspectRatioPostprocessApplyTo = Literal["all_visual_outputs"]
DEFAULT_PIPELINE_STAGE_AFTER_BY_KIND: dict[str, tuple[str, ...]] = {
    "mask_processing": ("aspect_ratio",),
}


class WorkflowRuleBaseModel(BaseModel):
    model_config = ConfigDict(extra="ignore")


class WorkflowRuleWarningModel(WorkflowRuleBaseModel):
    code: str
    message: str
    node_id: str | None = None
    output_index: int | None = None
    details: dict[str, Any] | None = None


class WorkflowRuleNodePresent(WorkflowRuleBaseModel):
    enabled: bool | None = None
    required: bool | None = None
    input_type: str | None = None
    param: str | None = None
    label: str | None = None
    class_type: str | None = None
    group_id: str | None = None
    group_title: str | None = None
    group_order: int | None = None


class WorkflowRuleWidgetInputPresenceCondition(WorkflowRuleBaseModel):
    kind: Literal["input_presence"] = "input_presence"
    inputs: list[str] = Field(default_factory=list)
    match: Literal[
        "all_present",
        "all_missing",
        "any_present",
        "any_missing",
    ] = "all_present"


class WorkflowRuleWidgetDefaultOverride(WorkflowRuleBaseModel):
    when: WorkflowRuleWidgetInputPresenceCondition
    value: Any | None = None


class WorkflowRuleWidgetEntry(WorkflowRuleBaseModel):
    label: str | None = None
    control_after_generate: bool = False
    default_randomize: bool | None = None
    frontend_only: bool | None = None
    hidden: bool | None = None
    control: WidgetControl | None = None
    slider_display: WidgetSliderDisplay | None = None
    unit: str | None = None
    group_id: str | None = None
    group_title: str | None = None
    group_order: int | None = None
    min: int | float | None = None
    max: int | float | None = None
    step: int | float | None = None
    default: Any | None = None
    value_type: PipelineControlValueType | None = None
    options: list[str | int | float | bool] | None = None
    true_value: Any | None = None
    false_value: Any | None = None
    default_overrides: list[WorkflowRuleWidgetDefaultOverride] | None = None


class WorkflowRuleBooleanOverride(WorkflowRuleBaseModel):
    when: WorkflowRuleWidgetInputPresenceCondition
    value: bool = True


class WorkflowRuleSelectionConfig(WorkflowRuleBaseModel):
    export_fps: int | None = None
    frame_step: int | None = None
    max_frames: int | None = None


class WorkflowRuleNode(WorkflowRuleBaseModel):
    model_config = ConfigDict(extra="forbid")

    ignore: bool = False
    ignore_overrides: list[WorkflowRuleBooleanOverride] | None = None
    present: WorkflowRuleNodePresent | None = None
    widgets_mode: WidgetsMode | None = None
    widgets: dict[str, WorkflowRuleWidgetEntry] = Field(default_factory=dict)
    selection: WorkflowRuleSelectionConfig | None = None
    node_title: str | None = None


class WorkflowRuleSlot(WorkflowRuleBaseModel):
    input_type: str | None = None
    label: str | None = None
    param: str | None = None
    experimental: bool | None = None
    export_fps: int | None = None
    frame_step: int | None = None
    max_frames: int | None = None


class WorkflowParamReference(WorkflowRuleBaseModel):
    node_id: str
    param: str


class WorkflowDualSamplerDenoiseRule(WorkflowRuleBaseModel):
    id: str
    kind: Literal["dual_sampler_denoise"] = "dual_sampler_denoise"
    label: str | None = None
    group_id: str | None = None
    group_title: str | None = None
    group_order: int | None = None
    total_steps: WorkflowParamReference
    start_step: WorkflowParamReference
    base_split_step: WorkflowParamReference
    split_step_targets: list[WorkflowParamReference] = Field(default_factory=list)


class WorkflowVideoAudioRetakeRule(WorkflowRuleBaseModel):
    """Derived widget that exposes a 3-option retake-mode enum.

    The selected mode drives two boolean bypass widgets: setting ``video_bypass``
    replaces the video retake mask with a solid pass-through mask, and likewise
    for ``audio_bypass``. Selecting "both" leaves both masks untouched.
    """

    id: str
    kind: Literal["video_audio_retake"] = "video_audio_retake"
    label: str | None = None
    group_id: str | None = None
    group_title: str | None = None
    group_order: int | None = None
    default: VideoAudioRetakeMode = "Video & Audio"
    video_bypass: WorkflowParamReference
    audio_bypass: WorkflowParamReference


WorkflowDerivedWidgetRule = Annotated[
    WorkflowDualSamplerDenoiseRule | WorkflowVideoAudioRetakeRule,
    Field(discriminator="kind"),
]


class WorkflowRequiredInputValidationRule(WorkflowRuleBaseModel):
    kind: Literal["required"]
    input: str
    message: str | None = None


class WorkflowAtLeastNInputValidationRule(WorkflowRuleBaseModel):
    kind: Literal["at_least_n"]
    inputs: list[str] = Field(default_factory=list)
    min: int
    message: str | None = None


class WorkflowOptionalInputValidationRule(WorkflowRuleBaseModel):
    kind: Literal["optional"]
    input: str
    message: str | None = None


InputValidationRule = Annotated[
    WorkflowRequiredInputValidationRule
    | WorkflowAtLeastNInputValidationRule
    | WorkflowOptionalInputValidationRule,
    Field(discriminator="kind"),
]


class WorkflowValidationConfig(WorkflowRuleBaseModel):
    inputs: list[InputValidationRule] = Field(default_factory=list)


class WorkflowInputCondition(WorkflowRuleBaseModel):
    kind: Literal["at_least_one"] = "at_least_one"
    inputs: list[str] = Field(default_factory=list)
    message: str | None = None


class NodeOutputSource(WorkflowRuleBaseModel):
    kind: Literal["node_output"] = "node_output"
    node_id: str
    output_index: int = 0


class ResolvedOutputInjectionRule(WorkflowRuleBaseModel):
    source: NodeOutputSource
    when: WorkflowRuleWidgetInputPresenceCondition | None = None


class WorkflowParamValueReference(WorkflowRuleBaseModel):
    kind: Literal["workflow_param"] = "workflow_param"
    node_id: str
    param: str


class PipelineControlReference(WorkflowRuleBaseModel):
    kind: Literal["pipeline_control"] = "pipeline_control"
    stage_id: str
    key: str


ControlValueReference = Annotated[
    WorkflowParamValueReference | PipelineControlReference,
    Field(discriminator="kind"),
]


class PipelineControlCondition(WorkflowRuleBaseModel):
    ref: ControlValueReference
    operator: PipelineComparisonOperator = "eq"
    value: Any | None = None


class PipelineControlDefaultRule(WorkflowRuleBaseModel):
    when: PipelineControlCondition
    value: Any | None = None


class PipelineControl(WorkflowRuleBaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    label: str | None = None
    description: str | None = None
    value_type: PipelineControlValueType = "unknown"
    expose: PipelineControlExposure = "widget"
    source: PipelineControlSource | None = None
    control: WidgetControl | None = None
    slider_display: WidgetSliderDisplay | None = None
    unit: str | None = None
    min: int | float | None = None
    max: int | float | None = None
    step: int | float | None = None
    default: Any | None = None
    options: list[str | int | float | bool] | None = None
    include_options: list[str | int | float | bool] | None = None
    exclude_options: list[str | int | float | bool] | None = None
    true_value: Any | None = None
    false_value: Any | None = None
    bind: ControlValueReference | None = None
    default_rules: list[PipelineControlDefaultRule] | None = None

    @model_validator(mode="after")
    def validate_key(self) -> "PipelineControl":
        if not self.key.strip():
            raise ValueError("Pipeline control key must be non-empty")
        return self

    @model_validator(mode="after")
    def validate_source(self) -> "PipelineControl":
        # `expose` is a purely presentational axis; `source` states who
        # authors the value. Widgets are always client-authored. For
        # non-widget controls, authorship is ambiguous and must be stated
        # explicitly — this is the invariant whose absence previously let
        # frontend-submitted `target_aspect_ratio` values be silently dropped.
        if self.expose == "widget":
            if self.source is None:
                self.source = "client"
            elif self.source != "client":
                raise ValueError(
                    f"pipeline control '{self.key}' is exposed as a widget "
                    "but declares source != 'client'"
                )
        else:
            if self.source is None:
                raise ValueError(
                    f"pipeline control '{self.key}' has expose='none' and "
                    "must declare source as 'client' or 'backend'"
                )
        return self


class MaskProcessingTarget(WorkflowRuleBaseModel):
    source: WorkflowParamReference
    mask: WorkflowParamReference
    mask_type: MaskProcessingTargetType = "binary"
    purpose: MaskProcessingTargetPurpose = "video"
    render_fps: int | None = None


class AspectRatioTargetNode(WorkflowRuleBaseModel):
    width: WorkflowParamReference
    height: WorkflowParamReference


class WorkflowAspectRatioPostprocessConfig(WorkflowRuleBaseModel):
    enabled: bool = True
    mode: AspectRatioPostprocessMode = "stretch_exact"
    apply_to: AspectRatioPostprocessApplyTo = "all_visual_outputs"


class WorkflowAspectRatioStageConfig(WorkflowRuleBaseModel):
    stride: int = 16
    search_steps: int = 2
    resolutions: list[int] = Field(default_factory=list)
    postprocess: WorkflowAspectRatioPostprocessConfig = Field(
        default_factory=WorkflowAspectRatioPostprocessConfig
    )


class WorkflowOutputAssemblyStageConfig(WorkflowRuleBaseModel):
    mode: PostprocessingMode = "auto"
    panel_preview: PostprocessingPanelPreview = "raw_outputs"
    on_failure: PostprocessingOnFailure = "fallback_raw"
    stitch_fps: int | None = None


class WorkflowPipelineStageBase(WorkflowRuleBaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    enabled: bool = True
    label: str | None = None
    description: str | None = None
    after: list[str] = Field(default_factory=list)
    controls: list[PipelineControl] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_id(self) -> "WorkflowPipelineStageBase":
        if not self.id.strip():
            raise ValueError("Pipeline stage id must be non-empty")
        return self


class WorkflowMaskProcessingStage(WorkflowPipelineStageBase):
    kind: Literal["mask_processing"] = "mask_processing"
    targets: list[MaskProcessingTarget] = Field(default_factory=list)


class WorkflowAspectRatioStage(WorkflowPipelineStageBase):
    kind: Literal["aspect_ratio"] = "aspect_ratio"
    config: WorkflowAspectRatioStageConfig = Field(
        default_factory=WorkflowAspectRatioStageConfig
    )
    targets: list[AspectRatioTargetNode] = Field(default_factory=list)


class WorkflowOutputAssemblyStage(WorkflowPipelineStageBase):
    kind: Literal["output_assembly"] = "output_assembly"
    config: WorkflowOutputAssemblyStageConfig = Field(
        default_factory=WorkflowOutputAssemblyStageConfig
    )


WorkflowPipelineStage = Annotated[
    WorkflowMaskProcessingStage
    | WorkflowAspectRatioStage
    | WorkflowOutputAssemblyStage,
    Field(discriminator="kind"),
]


class WorkflowRewriteCondition(WorkflowRuleBaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["input_missing", "input_present"]
    input: str


class WorkflowRewriteWidgetOverride(WorkflowRuleBaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str
    widget: str
    value: Any = None


class WorkflowRewriteRule(WorkflowRuleBaseModel):
    model_config = ConfigDict(extra="forbid")

    when: WorkflowRewriteCondition
    bypass: list[str] = Field(default_factory=list)
    set_widgets: list[WorkflowRewriteWidgetOverride] = Field(default_factory=list)


class ResolvedWorkflowRules(WorkflowRuleBaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[3] = 3
    name: str | None = None
    default_widgets_mode: WidgetsMode | None = None
    nodes: dict[str, WorkflowRuleNode] = Field(default_factory=dict)
    validation: WorkflowValidationConfig = Field(default_factory=WorkflowValidationConfig)
    input_conditions: list[WorkflowInputCondition] | None = None
    derived_widgets: list[WorkflowDerivedWidgetRule] = Field(default_factory=list)
    output_injections: dict[str, dict[str, ResolvedOutputInjectionRule]] = Field(
        default_factory=dict
    )
    rewrites: list[WorkflowRewriteRule] = Field(default_factory=list)
    slots: dict[str, WorkflowRuleSlot] = Field(default_factory=dict)
    pipeline: list[WorkflowPipelineStage] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_pipeline_graph(self) -> "ResolvedWorkflowRules":
        stage_ids = [stage.id for stage in self.pipeline]
        if len(stage_ids) != len(set(stage_ids)):
            raise ValueError("pipeline stage ids must be unique")

        stage_id_set = set(stage_ids)
        stages_by_kind: dict[str, list[WorkflowPipelineStage]] = defaultdict(list)
        for stage in self.pipeline:
            stages_by_kind[stage.kind].append(stage)

        def resolve_stage_reference(ref: str) -> list[str]:
            stripped = ref.strip()
            if not stripped:
                return []
            if stripped in stage_id_set:
                return [stripped]
            by_kind = stages_by_kind.get(stripped, [])
            return [stage.id for stage in by_kind]

        stage_dependencies: dict[str, set[str]] = {stage.id: set() for stage in self.pipeline}
        for stage in self.pipeline:
            control_keys = [control.key for control in stage.controls]
            if len(control_keys) != len(set(control_keys)):
                raise ValueError(
                    f"pipeline stage '{stage.id}' contains duplicate control keys"
                )

            for after_ref in stage.after:
                resolved_ids = resolve_stage_reference(after_ref)
                if not resolved_ids:
                    raise ValueError(
                        f"pipeline stage '{stage.id}' references unknown dependency '{after_ref}'"
                    )
                for dependency_id in resolved_ids:
                    if dependency_id == stage.id:
                        raise ValueError(
                            f"pipeline stage '{stage.id}' cannot depend on itself"
                        )
                    stage_dependencies[stage.id].add(dependency_id)

            for required_kind in DEFAULT_PIPELINE_STAGE_AFTER_BY_KIND.get(stage.kind, ()):
                for dependency_stage in stages_by_kind.get(required_kind, []):
                    if dependency_stage.id != stage.id:
                        stage_dependencies[stage.id].add(dependency_stage.id)

        visit_state: dict[str, int] = {}

        def visit_stage(stage_id: str) -> None:
            state = visit_state.get(stage_id, 0)
            if state == 2:
                return
            if state == 1:
                raise ValueError("pipeline stage dependency cycle detected")
            visit_state[stage_id] = 1
            for dependency_id in stage_dependencies.get(stage_id, set()):
                visit_stage(dependency_id)
            visit_state[stage_id] = 2

        for stage_id in stage_ids:
            visit_stage(stage_id)

        control_ids = {
            (stage.id, control.key)
            for stage in self.pipeline
            for control in stage.controls
        }
        control_dependencies: dict[tuple[str, str], set[tuple[str, str]]] = {
            control_id: set() for control_id in control_ids
        }

        def register_control_reference(
            *,
            owner_stage_id: str,
            owner_control_key: str,
            ref: ControlValueReference | None,
        ) -> None:
            if ref is None or ref.kind != "pipeline_control":
                return

            target_control = (ref.stage_id, ref.key)
            if target_control not in control_ids:
                raise ValueError(
                    "pipeline control reference points to an unknown stage/control"
                )
            control_dependencies[(owner_stage_id, owner_control_key)].add(target_control)

        for stage in self.pipeline:
            for control in stage.controls:
                register_control_reference(
                    owner_stage_id=stage.id,
                    owner_control_key=control.key,
                    ref=control.bind,
                )
                for default_rule in control.default_rules or []:
                    register_control_reference(
                        owner_stage_id=stage.id,
                        owner_control_key=control.key,
                        ref=default_rule.when.ref,
                    )

        control_visit_state: dict[tuple[str, str], int] = {}

        def visit_control(control_id: tuple[str, str]) -> None:
            state = control_visit_state.get(control_id, 0)
            if state == 2:
                return
            if state == 1:
                raise ValueError("pipeline control reference cycle detected")
            control_visit_state[control_id] = 1
            for dependency in control_dependencies.get(control_id, set()):
                visit_control(dependency)
            control_visit_state[control_id] = 2

        for control_id in control_ids:
            visit_control(control_id)

        return self


class WorkflowRulesResponse(WorkflowRuleBaseModel):
    workflow_id: str
    rules: ResolvedWorkflowRules
    warnings: list[WorkflowRuleWarningModel] = Field(default_factory=list)


def default_resolved_rules_model() -> ResolvedWorkflowRules:
    return ResolvedWorkflowRules()


def get_pipeline_stage(
    rules: ResolvedWorkflowRules | None,
    stage_name: str,
) -> WorkflowPipelineStage | None:
    if rules is None:
        return None
    for stage in rules.pipeline:
        if stage.id == stage_name or stage.kind == stage_name:
            return stage
    return None


def has_pipeline_stage(
    rules: ResolvedWorkflowRules | None,
    stage_name: str,
) -> bool:
    return get_pipeline_stage(rules, stage_name) is not None


def pipeline_stage_precedes(
    rules: ResolvedWorkflowRules | None,
    left_stage: str,
    right_stage: str,
) -> bool:
    if rules is None:
        return False

    left_index: int | None = None
    right_index: int | None = None
    for index, stage in enumerate(rules.pipeline):
        if left_index is None and (stage.id == left_stage or stage.kind == left_stage):
            left_index = index
        if right_index is None and (stage.id == right_stage or stage.kind == right_stage):
            right_index = index

    return left_index is not None and right_index is not None and left_index < right_index


def dump_resolved_rules(rules: ResolvedWorkflowRules) -> dict[str, Any]:
    return rules.model_dump(exclude_none=True)


def dump_warning_models(
    warnings: list[WorkflowRuleWarningModel],
) -> list[dict[str, Any]]:
    return [warning.model_dump(exclude_none=True) for warning in warnings]


def validation_warnings_from_error(
    exc: ValidationError,
    *,
    code: str,
    message_prefix: str,
) -> list[WorkflowRuleWarningModel]:
    warnings: list[WorkflowRuleWarningModel] = []
    for error in exc.errors():
        warnings.append(
            WorkflowRuleWarningModel(
                code=code,
                message=f"{message_prefix}: {error['msg']}",
                details={
                    "loc": list(error.get("loc", ())),
                    "type": error.get("type"),
                },
            )
        )
    return warnings
