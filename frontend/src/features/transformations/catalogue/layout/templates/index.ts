import { containTemplate } from "./contain";
import type { TransformTemplate } from "../../types";

export const TemplateRegistry: Record<string, TransformTemplate> = {
  contain: containTemplate,
  // Future: cover, center, etc.
};
