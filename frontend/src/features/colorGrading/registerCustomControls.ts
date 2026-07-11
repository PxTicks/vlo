import { registerCustomControl } from "../panelUI";
import {
  COLOR_WHEELS_CONTROL_ID,
  HUE_CURVES_CONTROL_ID,
  VALUE_CURVES_CONTROL_ID,
  TONE_SHAPING_CONTROL_ID,
  QUALIFIER_CONTROL_ID,
  LUT_CONTROL_ID,
  GRADE_MANAGEMENT_CONTROL_ID,
} from "./constants";
import { ColorWheelsControl } from "./components/ColorWheelsControl";
import { GradeCurvesControl } from "./components/GradeCurvesControl";
import { ToneShapingControl } from "./components/ToneShapingControl";
import { QualifierControl } from "./components/QualifierControl";
import { LutControl } from "./components/LutControl";
import { GradeManagementControl } from "./components/GradeManagementControl";

let registered = false;

export function registerColorGradingCustomControls(): void {
  if (registered) return;
  registered = true;
  registerCustomControl(COLOR_WHEELS_CONTROL_ID, ColorWheelsControl);
  registerCustomControl(VALUE_CURVES_CONTROL_ID, GradeCurvesControl);
  registerCustomControl(HUE_CURVES_CONTROL_ID, GradeCurvesControl);
  registerCustomControl(TONE_SHAPING_CONTROL_ID, ToneShapingControl);
  registerCustomControl(QUALIFIER_CONTROL_ID, QualifierControl);
  registerCustomControl(LUT_CONTROL_ID, LutControl);
  registerCustomControl(GRADE_MANAGEMENT_CONTROL_ID, GradeManagementControl);
}
