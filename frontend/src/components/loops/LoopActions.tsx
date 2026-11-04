import { Pause, Pencil, Play } from 'lucide-react';
import type { Loop } from '../../../../shared/types/loop';
import { useLoopsStore } from '../../stores/loopsStore';
import { Button } from '../ui/Button';

/** Run now, Pause or Resume, and Edit, on a loop's page. */
export function LoopActions({ loop }: { loop: Loop }) {
  const runNow = useLoopsStore(state => state.runNow);
  const setEnabled = useLoopsStore(state => state.setEnabled);
  const openDrawer = useLoopsStore(state => state.openDrawer);
  return (
    <>
      <Button size="sm" onClick={() => void runNow(loop.id)}><Play className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />Run now</Button>
      <Button size="sm" variant="secondary" onClick={() => void setEnabled(loop.id, !loop.enabled)}>
        {loop.enabled ? <Pause className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> : <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
        {loop.enabled ? 'Pause' : 'Resume'}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => openDrawer(loop.id)}><Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />Edit</Button>
    </>
  );
}
