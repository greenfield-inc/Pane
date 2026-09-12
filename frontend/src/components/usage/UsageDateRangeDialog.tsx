import { useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { USAGE_RETENTION_DAYS } from '../../../../shared/types/usage';

import { localDateString, type UsageDateRange } from './usageDateRange';

export function UsageDateRangeDialog({ initialRange, onApply, onClose }: {
  initialRange: UsageDateRange;
  onApply: (range: UsageDateRange) => void;
  onClose: () => void;
}) {
  const [start, setStart] = useState(initialRange.start);
  const [end, setEnd] = useState(initialRange.end);
  const today = localDateString(new Date());
  const valid = Boolean(start && end && start <= end && end <= today);

  return (
    <Modal isOpen onClose={onClose} size="sm">
      <form onSubmit={event => { event.preventDefault(); if (valid) onApply({ start, end }); }}>
        <ModalHeader title="Custom usage range" />
        <ModalBody className="space-y-3">
          <Input label="Start date" type="date" value={start} max={end || today} required fullWidth onChange={event => setStart(event.target.value)} />
          <Input label="End date" type="date" value={end} min={start} max={today} required fullWidth onChange={event => setEnd(event.target.value)} />
          <p className="text-xs text-text-tertiary">Includes both dates in your local time zone. Only indexed history is available; usage records are retained for {USAGE_RETENTION_DAYS} days.</p>
          {start && end && start > end && <p role="alert" className="text-xs text-status-error">End date must be on or after start date.</p>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!valid}>Apply range</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
