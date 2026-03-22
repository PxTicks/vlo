from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, ValidationError, model_validator


WidgetsMode = Literal["control_after_generate", "all"]
DerivedWidgetKind = Literal["dual_sampler_denoise"]
MaskCroppingMode = Literal["crop", "full"]
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


class WorkflowRuleWidgetEntry(WorkflowRuleBaseModel):
    label: str | None = None
    control_after_generate: bool = False
    default_randomize: bool | None = None
    frontend_only: bool | None = None
    hidden: bool | None = None
    group_id: str | None = None
    group_title: str | None = None
    group_order: int | None = None
    min: int | float | None = None
    max: int | float | None = None
    default: Any | None = None
    value_type: Literal["int", "float", "string", "boolean", "enum", "unknown"] | None = None
    options: list[str | int | float | bool] | None = None


class WorkflowRuleSelectionConfig(WorkflowRuleBaseModel):
    export_fps: int | None = None
    frame_step: int | None = None
    max_frames: int | None = None


class WorkflowRuleNodeBase(WorkflowRuleBaseModel):
    ignore: bool = False
    present: WorkflowRuleNodePresent | None = None
    widgets_mode: WidgetsMode | None = None
    widgets: dict[str, WorkflowRuleWidgetEntry] = Field(default_factory=dict)
    selection: WorkflowRuleSelectionConfig | None = None
    binary_derived_mask_of: str | None = None
    soft_derived_mask_of: str | None = None


class AuthoredWorkflowRuleNodeV1(WorkflowRuleNodeBase):
    pass


class ResolvedWorkflowRuleNode(WorkflowRuleNodeBase):
    node_title: str | None = None


class WorkflowRuleSlot(WorkflowRuleBaseModel):
    input_type: str | None = None
    label: str | None = None
    param: str | None = None
    experimental: bool | None = None
    export_fps: int | None = None
    frame_step: int | None = None
    max_frames: int | None = None


class WorkflowMaskCroppingConfig(WorkflowRuleBaseModel):
    mode: MaskCroppingMode = "crop"


class WorkflowPostprocessingConfig(WorkflowRuleBaseModel):
    mode: PostprocessingMode = "auto"
    panel_preview: PostprocessingPanelPreview = "raw_outputs"
    on_failure: PostprocessingOnFailure = "fallback_raw"
    stitch_fps: int | None = None


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


class AspectRatioTargetNode(WorkflowRuleBaseModel):
    node_id: str
    width_param: str
    height_param: str


class WorkflowAspectRatioPostprocessConfig(WorkflowRuleBaseModel):
    enabled: bool = True
    mode: AspectRatioPostprocessMode = "stretch_exact"
    apply_to: AspectRatioPostprocessApplyTo = "all_visual_outputs"


class WorkflowAspectRatioProcessingConfig(WorkflowRuleBaseModel):
    enabled: bool = False
    stride: int = 16
    search_steps: int = 2
    resolutions: list[int] = Field(default_factory=list)
    target_nodes: list[AspectRatioTargetNode] = Field(default_factory=list)
    postprocess: WorkflowAspectRatioPostprocessConfig = Field(
        default_factory=WorkflowAspectRatioPostprocessConfig
    )


class AuthoredWorkflowRulesV1(WorkflowRuleBaseModel):
    version: int = 1
    name: str | None = None
    nodes: dict[str, AuthoredWorkflowRuleNodeV1] = Field(default_factory=dict)
    validation: WorkflowValidationConfig = Field(default_factory=WorkflowValidationConfig)
    input_conditions: list[WorkflowInputCondition] | None = None
    derived_widgets: list[WorkflowDualSamplerDenoiseRule] = Field(default_factory=list)
    output_injections: dict[str, dict[str, ResolvedOutputInjectionRule]] = Field(
        default_factory=dict
    )
    slots: dict[str, WorkflowRuleSlot] = Field(default_factory=dict)
    mask_cropping: WorkflowMaskCroppingConfig = Field(
        default_factory=WorkflowMaskCroppingConfig
    )
    postprocessing: WorkflowPostprocessingConfig = Field(
        default_factory=WorkflowPostprocessingConfig
    )
    aspect_ratio_processing: WorkflowAspectRatioProcessingConfig = Field(
        default_factory=WorkflowAspectRatioProcessingConfig
    )


class ResolvedWorkflowRules(WorkflowRuleBaseModel):
    version: int = 1
    name: str | None = None
    nodes: dict[str, ResolvedWorkflowRuleNode] = Field(default_factory=dict)
    validation: WorkflowValidationConfig = Field(default_factory=WorkflowValidationConfig)
    input_conditions: list[WorkflowInputCondition] | None = None
    derived_widgets: list[WorkflowDualSamplerDenoiseRule] = Field(default_factory=list)
    output_injections: dict[str, dict[str, ResolvedOutputInjectionRule]] = Field(
        default_factory=dict
    )
    slots: dict[str, WorkflowRuleSlot] = Field(default_factory=dict)
    mask_cropping: WorkflowMaskCroppingConfig = Field(
        default_factory=WorkflowMaskCroppingConfig
    )
    postprocessing: WorkflowPostprocessingConfig = Field(
        default_factory=WorkflowPostprocessingConfig
    )
    aspect_ratio_processing: WorkflowAspectRatioProcessingConfig = Field(
        default_factory=WorkflowAspectRatioProcessingConfig
    )

    _default_widgets_mode: WidgetsMode | None = PrivateAttr(default=None)
    _pipeline_stage_order: tuple[str, ...] = PrivateAttr(
        default=("mask_cropping", "aspect_ratio")
    )
    _has_explicit_pipeline: bool = PrivateAttr(default=False)

    def set_runtime_defaults(
        self,
        *,
        default_widgets_mode: WidgetsMode | None = None,
        pipeline_stage_order: tuple[str, ...] | None = None,
        has_explicit_pipeline: bool = False,
    ) -> None:
        self._default_widgets_mode = default_widgets_mode
        if pipeline_stage_order is not None:
            self._pipeline_stage_order = pipeline_stage_order
        self._has_explicit_pipeline = has_explicit_pipeline


class WorkflowRulesResponse(WorkflowRuleBaseModel):
    workflow_id: str
    rules: ResolvedWorkflowRules
    warnings: list[WorkflowRuleWarningModel] = Field(default_factory=list)


class NodeInputRef(WorkflowRuleBaseModel):
    node_id: str
    param: str | None = None


V2InputRef = NodeInputRef


class V2RequiredInputValidationRule(WorkflowRuleBaseModel):
    kind: Literal["required"]
    input: V2InputRef
    message: str | None = None


class V2AtLeastNInputValidationRule(WorkflowRuleBaseModel):
    kind: Literal["at_least_n"]
    inputs: list[V2InputRef] = Field(default_factory=list)
    min: int
    message: str | None = None


class V2OptionalInputValidationRule(WorkflowRuleBaseModel):
    kind: Literal["optional"]
    input: V2InputRef
    message: str | None = None


V2InputValidationRule = Annotated[
    V2RequiredInputValidationRule
    | V2AtLeastNInputValidationRule
    | V2OptionalInputValidationRule,
    Field(discriminator="kind"),
]


class V2ValidationConfig(WorkflowRuleBaseModel):
    inputs: list[V2InputValidationRule] = Field(default_factory=list)


class AuthoredWorkflowRuleNodeV2(WorkflowRuleNodeBase):
    present: WorkflowRuleNodePresent | None = None

    @model_validator(mode="after")
    def validate_present_input_type(self) -> "AuthoredWorkflowRuleNodeV2":
        if self.present and self.present.input_type is not None:
            if self.present.input_type not in {"text", "image", "video"}:
                raise ValueError("present.input_type must be one of text|image|video")
        return self


class NodeOutputSourceV2(WorkflowRuleBaseModel):
    kind: Literal["node_output"] = "node_output"
    node_id: str
    output_index: int = 0


class OutputInjectionRuleV2(WorkflowRuleBaseModel):
    target_node_id: str
    target_output_index: int = 0
    source: NodeOutputSourceV2


class MaskCroppingPipelineStageV2(WorkflowRuleBaseModel):
    kind: Literal["mask_cropping"] = "mask_cropping"
    mode: MaskCroppingMode = "crop"


class AspectRatioPipelineStageV2(WorkflowRuleBaseModel):
    kind: Literal["aspect_ratio"] = "aspect_ratio"
    enabled: bool = False
    stride: int = 16
    search_steps: int = 2
    resolutions: list[int] = Field(default_factory=list)
    target_nodes: list[AspectRatioTargetNode] = Field(default_factory=list)
    postprocess: WorkflowAspectRatioPostprocessConfig = Field(
        default_factory=WorkflowAspectRatioPostprocessConfig
    )


WorkflowPipelineStageV2 = Annotated[
    MaskCroppingPipelineStageV2 | AspectRatioPipelineStageV2,
    Field(discriminator="kind"),
]


class AuthoredWorkflowRulesV2(WorkflowRuleBaseModel):
    version: Literal[2] = 2
    name: str | None = None
    default_widgets_mode: WidgetsMode | None = None
    nodes: dict[str, AuthoredWorkflowRuleNodeV2] = Field(default_factory=dict)
    pipeline: list[WorkflowPipelineStageV2] | None = None
    validation: V2ValidationConfig = Field(default_factory=V2ValidationConfig)
    derived_widgets: list[WorkflowDualSamplerDenoiseRule] = Field(default_factory=list)
    output_injections: list[OutputInjectionRuleV2] = Field(default_factory=list)
    slots: dict[str, WorkflowRuleSlot] = Field(default_factory=dict)
    postprocessing: WorkflowPostprocessingConfig = Field(
        default_factory=WorkflowPostprocessingConfig
    )

    @model_validator(mode="after")
    def validate_unique_pipeline_kinds(self) -> "AuthoredWorkflowRulesV2":
        if self.pipeline is None:
            return self
        kinds = [stage.kind for stage in self.pipeline]
        if len(kinds) != len(set(kinds)):
            raise ValueError("pipeline kinds must be unique")
        return self


def default_resolved_rules_model() -> ResolvedWorkflowRules:
    model = ResolvedWorkflowRules()
    model.set_runtime_defaults()
    return model


def has_pipeline_stage(
    rules: ResolvedWorkflowRules | None,
    stage_name: str,
) -> bool:
    if rules is None:
        return False
    if not rules._has_explicit_pipeline:
        return stage_name in {"mask_cropping", "aspect_ratio"}
    return stage_name in rules._pipeline_stage_order


def pipeline_stage_precedes(
    rules: ResolvedWorkflowRules | None,
    left_stage: str,
    right_stage: str,
) -> bool:
    if rules is None:
        return False
    if not rules._has_explicit_pipeline:
        default_order = ("mask_cropping", "aspect_ratio")
        return default_order.index(left_stage) < default_order.index(right_stage)

    try:
        return rules._pipeline_stage_order.index(left_stage) < rules._pipeline_stage_order.index(
            right_stage
        )
    except ValueError:
        return False


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


def compile_authored_v1_to_resolved(
    authored: AuthoredWorkflowRulesV1,
) -> ResolvedWorkflowRules:
    resolved = ResolvedWorkflowRules.model_validate(
        authored.model_dump(exclude_none=True)
    )
    resolved.set_runtime_defaults()
    return resolved


def _compile_v2_input_ref(ref: V2InputRef) -> str:
    if ref.param:
        return f"{ref.node_id}:{ref.param}"
    return ref.node_id


def _compile_v2_validation(
    validation: V2ValidationConfig,
) -> WorkflowValidationConfig:
    compiled_rules: list[InputValidationRule] = []
    for rule in validation.inputs:
        if isinstance(rule, V2RequiredInputValidationRule):
            compiled_rules.append(
                WorkflowRequiredInputValidationRule(
                    kind="required",
                    input=_compile_v2_input_ref(rule.input),
                    message=rule.message,
                )
            )
            continue
        if isinstance(rule, V2OptionalInputValidationRule):
            compiled_rules.append(
                WorkflowOptionalInputValidationRule(
                    kind="optional",
                    input=_compile_v2_input_ref(rule.input),
                    message=rule.message,
                )
            )
            continue
        compiled_rules.append(
            WorkflowAtLeastNInputValidationRule(
                kind="at_least_n",
                inputs=[_compile_v2_input_ref(ref) for ref in rule.inputs],
                min=rule.min,
                message=rule.message,
            )
        )
    return WorkflowValidationConfig(inputs=compiled_rules)


def _compile_v2_output_injections(
    authored: AuthoredWorkflowRulesV2,
) -> dict[str, dict[str, ResolvedOutputInjectionRule]]:
    compiled: dict[str, dict[str, ResolvedOutputInjectionRule]] = {}
    for injection in authored.output_injections:
        source = NodeOutputSource(
            kind="node_output",
            node_id=injection.source.node_id,
            output_index=injection.source.output_index,
        )
        compiled.setdefault(injection.target_node_id, {})[
            str(injection.target_output_index)
        ] = ResolvedOutputInjectionRule(source=source)
    return compiled


def compile_authored_v2_to_resolved(
    authored: AuthoredWorkflowRulesV2,
) -> ResolvedWorkflowRules:
    mask_cropping = WorkflowMaskCroppingConfig()
    aspect_ratio_processing = WorkflowAspectRatioProcessingConfig()
    pipeline_stage_order: tuple[str, ...]
    has_explicit_pipeline = authored.pipeline is not None

    if authored.pipeline is None:
        pipeline_stage_order = ("mask_cropping", "aspect_ratio")
    else:
        pipeline_stage_order = tuple(stage.kind for stage in authored.pipeline)
        mask_stage = next(
            (stage for stage in authored.pipeline if isinstance(stage, MaskCroppingPipelineStageV2)),
            None,
        )
        if mask_stage is None:
            mask_cropping = WorkflowMaskCroppingConfig(mode="full")
        else:
            mask_cropping = WorkflowMaskCroppingConfig(mode=mask_stage.mode)

        aspect_stage = next(
            (stage for stage in authored.pipeline if isinstance(stage, AspectRatioPipelineStageV2)),
            None,
        )
        if aspect_stage is not None:
            aspect_ratio_processing = WorkflowAspectRatioProcessingConfig(
                enabled=aspect_stage.enabled,
                stride=aspect_stage.stride,
                search_steps=aspect_stage.search_steps,
                resolutions=list(aspect_stage.resolutions),
                target_nodes=list(aspect_stage.target_nodes),
                postprocess=aspect_stage.postprocess,
            )

    resolved = ResolvedWorkflowRules(
        version=2,
        name=authored.name,
        nodes={
            node_id: ResolvedWorkflowRuleNode.model_validate(
                node_rule.model_dump(exclude_none=True)
            )
            for node_id, node_rule in authored.nodes.items()
        },
        validation=_compile_v2_validation(authored.validation),
        derived_widgets=list(authored.derived_widgets),
        output_injections=_compile_v2_output_injections(authored),
        slots=dict(authored.slots),
        mask_cropping=mask_cropping,
        postprocessing=authored.postprocessing,
        aspect_ratio_processing=aspect_ratio_processing,
    )
    resolved.set_runtime_defaults(
        default_widgets_mode=authored.default_widgets_mode,
        pipeline_stage_order=pipeline_stage_order,
        has_explicit_pipeline=has_explicit_pipeline,
    )
    return resolved


def _parse_legacy_input_ref(value: str) -> V2InputRef:
    if ":" in value:
        node_id, param = value.split(":", 1)
        return NodeInputRef(node_id=node_id, param=param)
    return NodeInputRef(node_id=value)


def migrate_authored_v1_to_v2(
    authored: AuthoredWorkflowRulesV1,
) -> AuthoredWorkflowRulesV2:
    validation_inputs: list[V2InputValidationRule] = []
    source_validation = authored.validation.inputs
    if not source_validation and authored.input_conditions:
        source_validation = [
            WorkflowAtLeastNInputValidationRule(
                kind="at_least_n",
                inputs=condition.inputs,
                min=1,
                message=condition.message,
            )
            for condition in authored.input_conditions
        ]

    for rule in source_validation:
        if isinstance(rule, WorkflowRequiredInputValidationRule):
            validation_inputs.append(
                V2RequiredInputValidationRule(
                    kind="required",
                    input=_parse_legacy_input_ref(rule.input),
                    message=rule.message,
                )
            )
            continue
        if isinstance(rule, WorkflowOptionalInputValidationRule):
            validation_inputs.append(
                V2OptionalInputValidationRule(
                    kind="optional",
                    input=_parse_legacy_input_ref(rule.input),
                    message=rule.message,
                )
            )
            continue
        validation_inputs.append(
            V2AtLeastNInputValidationRule(
                kind="at_least_n",
                inputs=[_parse_legacy_input_ref(value) for value in rule.inputs],
                min=rule.min,
                message=rule.message,
            )
        )

    output_injections: list[OutputInjectionRuleV2] = []
    for target_node_id, outputs in authored.output_injections.items():
        for output_index, injection_rule in outputs.items():
            source = injection_rule.source
            output_injections.append(
                OutputInjectionRuleV2(
                    target_node_id=target_node_id,
                    target_output_index=int(output_index),
                    source=NodeOutputSourceV2(
                        kind="node_output",
                        node_id=source.node_id,
                        output_index=source.output_index,
                    ),
                )
            )

    pipeline: list[WorkflowPipelineStageV2] = [
        MaskCroppingPipelineStageV2(
            kind="mask_cropping",
            mode=authored.mask_cropping.mode,
        ),
        AspectRatioPipelineStageV2(
            kind="aspect_ratio",
            enabled=authored.aspect_ratio_processing.enabled,
            stride=authored.aspect_ratio_processing.stride,
            search_steps=authored.aspect_ratio_processing.search_steps,
            resolutions=list(authored.aspect_ratio_processing.resolutions),
            target_nodes=list(authored.aspect_ratio_processing.target_nodes),
            postprocess=authored.aspect_ratio_processing.postprocess,
        ),
    ]

    return AuthoredWorkflowRulesV2(
        version=2,
        name=authored.name,
        nodes={
            node_id: AuthoredWorkflowRuleNodeV2.model_validate(
                node_rule.model_dump(exclude_none=True)
            )
            for node_id, node_rule in authored.nodes.items()
        },
        pipeline=pipeline,
        validation=V2ValidationConfig(inputs=validation_inputs),
        derived_widgets=list(authored.derived_widgets),
        output_injections=output_injections,
        slots=dict(authored.slots),
        postprocessing=authored.postprocessing,
    )
