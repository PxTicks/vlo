import { registerCustomControl } from "../panelUI";
import {
  COLOR_WHEELS_CONTROL_ID,
  HUE_CURVES_CONTROL_ID,
  VALUE_CURVES_CONTROL_ID,
} from "./constants";
import { ColorWheelsControl } from "./components/ColorWheelsControl";
import { GradeCurvesControl } from "./components/GradeCurvesControl";

let registered = false;

export function registerColorGradingCustomControls(): void {
  if (registered) return;
  registered = true;
  registerCustomControl(COLOR_WHEELS_CONTROL_ID, ColorWheelsControl);
  registerCustomControl(VALUE_CURVES_CONTROL_ID, GradeCurvesControl);
  registerCustomControl(HUE_CURVES_CONTROL_ID, GradeCurvesControl);
}
