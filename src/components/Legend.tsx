import { STATUS_ORDER } from '../../engine/certainty';
import { STATUS_LABEL, STATUS_MEANING, StatusMark } from '@/lib/status';

export function Legend() {
  return (
    <details className="rounded-md border border-border bg-card px-3 py-2 text-xs" open>
      <summary className="cursor-pointer font-medium text-ink-2">Status legend</summary>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 lg:grid-cols-2">
        {STATUS_ORDER.map((s) => (
          <div key={s} className="flex gap-2">
            <dt className="w-28 shrink-0">
              <StatusMark status={s} />
            </dt>
            <dd className="text-muted-foreground">
              <span className="sr-only">{STATUS_LABEL[s]}: </span>
              {STATUS_MEANING[s]}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
