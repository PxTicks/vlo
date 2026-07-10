import { useEffect, useState } from "react";
import {
  colorGradeHistogramRuntime,
  type ColorGradeHistogramSnapshot,
} from "../../../core/color";
import { livePreviewParamStore } from "../../../core/liveParams/livePreviewParamStore";

export function useCurveHistograms(
  transformId: string,
  active = true,
): ColorGradeHistogramSnapshot | null {
  const key = active ? transformId : null;
  const [state, setState] = useState<{
    key: string | null;
    snapshot: ColorGradeHistogramSnapshot | null;
  }>({ key: null, snapshot: null });
  useEffect(() => {
    if (!active) return;
    const unsubscribe = colorGradeHistogramRuntime.subscribe(transformId, (snapshot) => {
      setState({ key: transformId, snapshot });
    });
    livePreviewParamStore.requestRender();
    return unsubscribe;
  }, [active, transformId]);
  return state.key === key ? state.snapshot : null;
}
