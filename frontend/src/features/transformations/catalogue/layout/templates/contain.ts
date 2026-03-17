import type { TransformTemplate } from "../../types";

export const containTemplate: TransformTemplate = ({ container, content }) => {
  const scaleX = container.width / (content.width || 1);
  const scaleY = container.height / (content.height || 1);
  const scale = Math.min(scaleX, scaleY);

  return {
    scaleX: scale,
    scaleY: scale,
    x: container.width / 2,
    y: container.height / 2,
    rotation: 0,
    alpha: 1,
  };
};
