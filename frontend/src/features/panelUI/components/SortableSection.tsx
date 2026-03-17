import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PanelSection } from "./PanelSection";

interface SortableSectionToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
}

interface SortableSectionProps {
  id: string;
  title: string;
  bgColor: string;
  onRemove?: () => void;
  children: React.ReactNode;
  isPanelDragging: boolean;
  isOpen: boolean;
  onToggle: () => void;
  sectionToggle?: SortableSectionToggleProps;
  isActive?: boolean;
  onSectionClick?: () => void;
}

export function SortableSection({
  id,
  title,
  bgColor,
  onRemove,
  children,
  isPanelDragging,
  isOpen,
  onToggle,
  sectionToggle,
  isActive,
  onSectionClick,
}: SortableSectionProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform: dndTransform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(dndTransform),
    transition,
    zIndex: isDragging ? 999 : "auto",
    position: "relative" as const,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <PanelSection
        title={title}
        bgColor={bgColor}
        onRemove={onRemove}
        dragHandleProps={{ ...attributes, ...listeners }}
        isDragging={isDragging}
        dimmed={isPanelDragging && !isDragging}
        isOpen={isOpen}
        onToggle={onToggle}
        sectionToggle={sectionToggle}
        isActive={isActive}
        onSectionClick={onSectionClick}
      >
        {children}
      </PanelSection>
    </div>
  );
}
