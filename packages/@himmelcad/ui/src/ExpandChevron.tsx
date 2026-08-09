import { ChevronDown, ChevronRight } from 'lucide-react';

export interface ExpandChevronProps {
  expanded: boolean;
  size?: number;
  className?: string;
}

/**
 * Standard disclosure: collapsed = right (›), expanded = down (v).
 */
export function ExpandChevron({ expanded, size = 14, className }: ExpandChevronProps): JSX.Element {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return <Icon size={size} className={className} aria-hidden />;
}
