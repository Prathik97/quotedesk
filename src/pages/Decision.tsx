// The Decision page: pick a scenario, see the allocation, readiness, sensitivity, then create the pack.
// The scenario runs in the browser with the same award engine the analyst and the memo use. No model call.
import { useState } from 'react';
import { ByLine, ByVendor, Extras, Totals } from '@/components/decision/Allocation';
import { ScenarioControls } from '@/components/decision/Controls';
import { PackPanel } from '@/components/decision/PackPanel';
import { ReadinessPanel } from '@/components/decision/Readiness';
import { SensitivityPanel } from '@/components/decision/SensitivityPanel';
import { ErrorBox, Loading, PageTitle } from '@/components/ui';
import { controlsToScenario, DEFAULT_CONTROLS, useScenarioRun, type Controls } from '@/lib/decision';
import { useApp } from '@/lib/store';

export function Decision() {
  const { data, loading, error, reload } = useApp();
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const { run, error: scenarioError } = useScenarioRun(data, controlsToScenario(controls));
  if (error && !data) return <ErrorBox message={error} onRetry={() => void reload()} />;
  if (loading || !data) return <Loading what="the decision" />;
  const needVendor = controls.strategy === 'single_vendor' && !controls.vendor;
  const blocked = scenarioError ?? (needVendor ? 'Pick a vendor for a single vendor award.' : null);

  return (
    <div>
      <PageTitle title="Decision" sub="Choose a scenario, see who wins which lines and what is still open, then create the decision pack. Nothing here calls a model except the approval note." />
      <div className="flex items-start gap-5">
        <div className="sticky top-0 w-[19rem] shrink-0 space-y-4 self-start">
          <ScenarioControls value={controls} onChange={setControls} data={data} />
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          {blocked ? (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
              <p className="font-medium text-status-assumed">This scenario cannot run</p>
              <p className="mt-1">{blocked}</p>
            </div>
          ) : null}
          {run ? (
            <>
              <ReadinessPanel result={run.result} data={data} />
              <Totals result={run.result} />
              <ByVendor result={run.result} />
              <ByLine result={run.result} data={data} />
              <Extras result={run.result} />
              <SensitivityPanel s={run.sensitivity} />
            </>
          ) : null}
          <PackPanel controls={controls} disabled={!run} disabledReason={blocked} />
        </div>
      </div>
    </div>
  );
}
