// The status vocabulary: icon plus text plus colour, never colour alone.
import { CircleCheck, CircleDot, CircleOff, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { STATUS_LABEL, STATUS_MEANING, type CellStatus } from '../../engine/certainty';
import { cn } from './utils';

export const STATUS_ICON: Record<CellStatus, LucideIcon> = {
  confirmed: CircleCheck,
  assumed: CircleDot,
  needs_review: TriangleAlert,
  conflict: OctagonX,
  missing: CircleOff,
};

export const STATUS_TEXT_CLASS: Record<CellStatus, string> = {
  confirmed: 'text-status-confirmed',
  assumed: 'text-status-assumed',
  needs_review: 'text-status-review',
  conflict: 'text-status-conflict',
  missing: 'text-status-missing',
};

export const STATUS_BG_CLASS: Record<CellStatus, string> = {
  confirmed: 'bg-green-50 border-green-200',
  assumed: 'bg-amber-50 border-amber-200',
  needs_review: 'bg-orange-50 border-orange-200',
  conflict: 'bg-red-50 border-red-200',
  missing: 'bg-slate-100 border-slate-200',
};

export function StatusMark({ status, className, size = 14 }: { status: CellStatus; className?: string; size?: number }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium', STATUS_TEXT_CLASS[status], className)} title={STATUS_MEANING[status]}>
      <Icon size={size} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

export { STATUS_LABEL, STATUS_MEANING };
