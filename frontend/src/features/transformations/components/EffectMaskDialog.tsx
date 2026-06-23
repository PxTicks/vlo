import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from "@mui/material";
import type {
  EffectMask,
  MaskBooleanExpression,
  MaskTimelineClip,
} from "../../../types/TimelineTypes";
import { MaskEquationBuilder } from "../../masks/components/MaskEquationBuilder";

interface EffectMaskDialogProps {
  open: boolean;
  onClose: () => void;
  /** Filter title, for the dialog heading. */
  title: string;
  /** The parent clip's masks — the variables an effect-mask equation references. */
  masks: MaskTimelineClip[];
  effectMask: EffectMask | undefined;
  onChange: (effectMask: EffectMask) => void;
}

/**
 * Authoring surface for a filter's effect-level mask: reuses
 * {@link MaskEquationBuilder} to compose an equation over the clip's existing
 * masks (no mask-mutation actions here — those belong to the mask panel) and
 * writes it back as the filter's {@link EffectMask}. The filter applies to the
 * whole frame and is composited through the equation's coverage; an enabled
 * mask with no expression contributes nothing (never a whole-clip effect).
 */
export function EffectMaskDialog({
  open,
  onClose,
  title,
  masks,
  effectMask,
  onChange,
}: EffectMaskDialogProps) {
  const expression = effectMask?.expression ?? null;
  const enabled = !!effectMask?.enabled;

  // Always carry mode: "composite" (the only v1 mode) and merge the single
  // field that changed, so toggling on/off never drops the equation and vice
  // versa.
  const emit = (next: {
    expression?: MaskBooleanExpression | null;
    enabled?: boolean;
  }) => {
    onChange({
      mode: "composite",
      enabled: next.enabled ?? enabled,
      expression:
        next.expression !== undefined ? next.expression : expression,
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      data-testid="effect-mask-dialog"
    >
      <DialogTitle>Effect mask — {title}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
          Apply this filter only where the mask equation is opaque. The filter
          renders over the whole frame and is composited through the equation
          built from this clip&apos;s masks.
        </Typography>
        {masks.length === 0 ? (
          <Typography
            variant="body2"
            sx={{ color: "text.secondary", py: 2 }}
            data-testid="effect-mask-no-masks"
          >
            This clip has no masks yet. Add masks to the clip in the Mask panel
            first, then build an equation here.
          </Typography>
        ) : (
          <MaskEquationBuilder
            masks={masks}
            expression={expression}
            onExpressionChange={(next) => emit({ expression: next })}
            expressionEnabled={enabled}
            onExpressionEnabledChange={(next) => emit({ enabled: next })}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="effect-mask-dialog-close">
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
