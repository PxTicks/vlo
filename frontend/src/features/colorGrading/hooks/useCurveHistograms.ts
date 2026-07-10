import { useEffect, useState } from "react";
import { curveHistogramSampler } from "../services/curveHistogramSampler";
import type { CurveHistograms } from "../utils/curveHistogram";

export function useCurveHistograms(referenceKey: string): CurveHistograms | null {
  const [reference, setReference] = useState<{
    key: string;
    histograms: CurveHistograms | null;
  }>({ key: referenceKey, histograms: null });
  if (reference.key !== referenceKey) {
    setReference({ key: referenceKey, histograms: null });
  }
  useEffect(() => {
    return curveHistogramSampler.subscribe(referenceKey, (histograms) => {
      setReference({ key: referenceKey, histograms });
    });
  }, [referenceKey]);
  return reference.key === referenceKey ? reference.histograms : null;
}
