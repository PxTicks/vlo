import { useCallback, useEffect } from "react";
import { useTransformationViewStore } from "../store/useTransformationViewStore";

interface UseActiveTransformationSectionResult {
  activeSectionId: string | null;
  activateSection: (sectionId: string) => void;
}

export function useActiveTransformationSection(
  activeContextId: string | undefined,
  sectionOrder: string[],
): UseActiveTransformationSectionResult {
  const activeSection = useTransformationViewStore((state) => state.activeSection);
  const setActiveSection = useTransformationViewStore(
    (state) => state.setActiveSection,
  );

  const activateSection = useCallback(
    (sectionId: string) => {
      if (!activeContextId) return;
      setActiveSection({ clipId: activeContextId, sectionId });
    },
    [activeContextId, setActiveSection],
  );

  useEffect(() => {
    if (!activeContextId) {
      if (activeSection !== null) {
        setActiveSection(null);
      }
      return;
    }

    if (sectionOrder.length === 0) {
      if (activeSection?.clipId === activeContextId) {
        setActiveSection(null);
      }
      return;
    }

    const isCurrentSectionValid =
      activeSection?.clipId === activeContextId &&
      sectionOrder.includes(activeSection.sectionId);

    if (!isCurrentSectionValid) {
      setActiveSection({
        clipId: activeContextId,
        sectionId: sectionOrder[0],
      });
    }
  }, [activeContextId, activeSection, sectionOrder, setActiveSection]);

  return {
    activeSectionId:
      activeSection !== null &&
      activeSection.clipId === activeContextId
        ? activeSection.sectionId
        : null,
    activateSection,
  };
}
