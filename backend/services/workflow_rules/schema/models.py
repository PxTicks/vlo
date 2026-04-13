from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


WidgetsMode = Literal["control_after_generate", "all"]
DerivedWidgetKind = Literal["dual_sampler_denoise"]
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
PipelineControlExposure = Literal["widget", "hidden"]
PipelineControlValueType = Literal["int", "float", "string", "boolean", "enum", "unknown"]
MaskProcessingTargetType = Literal["binary", "soft"]
MaskProcessingTargetPurpose = Literal["video", "audio_timing"]
PostprocessingMode = Literal["auto", "stitch_frames_with_audio", "none"]
PostprocessingPanelPreview = Literal["raw_outputs", "replace_outputs"]
PostprocessingOnFailure = Literal["fallback_raw", "show_error"]
AspectRatioPostprocessMode = Literal["stretch_exact"]
AspectRatioPostprocessApplyTo = Literal["all_visual_outputs"]


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
    kind: DerivedWidgetKind = "dual_sampler_denoise"
    label: str | None = None
    group_id: str | None = None
    group_title: str | None = None
    group_order: int | None = None
    total_steps: WorkflowParamReference
    start_step: WorkflowParamReference
    base_split_step: WorkflowParamReference
    split_step_targets: list[WorkflowParamReference] = Field(default_factory=list)


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
    key: str
    label: str | None = None
    value_type: PipelineControlValueType = "unknown"
    expose: PipelineControlExposure = "widget"
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
    id: str
    enabled: bool = True
    label: str | None = None
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


class ResolvedWorkflowRules(WorkflowRuleBaseModel):
    version: Literal[3] = 3
    name: str | None = None
    default_widgets_mode: WidgetsMode | None = None
    nodes: dict[str, WorkflowRuleNode] = Field(default_factory=dict)
    validation: WorkflowValidationConfig = Field(default_factory=WorkflowValidationConfig)
    input_conditions: list[WorkflowInputCondition] | None = None
    derived_widgets: list[WorkflowDualSamplerDenoiseRule] = Field(default_factory=list)
    output_injections: dict[str, dict[str, ResolvedOutputInjectionRule]] = Field(
        default_factory=dict
    )
    slots: dict[str, WorkflowRuleSlot] = Field(default_factory=dict)
    pipeline: list[WorkflowPipelineStage] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_unique_stage_ids(self) -> "ResolvedWorkflowRules":
        stage_ids = [stage.id for stage in self.pipeline]
        if len(stage_ids) != len(set(stage_ids)):
            raise ValueError("pipeline stage ids must be unique")
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
