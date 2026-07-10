import { useEffect, useState } from "react";
import { curveHistogramSampler } from "../services/curveHistogramSampler";
import type { CurveHistograms } from "../utils/curveHistogram";

export function useCurveHistograms(): CurveHistograms | null {
  const [histograms, setHistograms] = useState<CurveHistograms | null>(null);
  useEffect(() => curveHistogramSampler.subscribe(setHistograms), []);
  return histograms;
}
