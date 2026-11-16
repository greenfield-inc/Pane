import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { HealthCardBody } from './HealthCardBody';
import { answerHealthCard, askAgentAbout, cardTitle, isHealthCard, remoteMachineName, reviewHealthCard } from './healthCardActions';

/**
 * Inside the Pane window, a waiting machine health card opens as a dialog, this
 * machine's or a linked machine's. Closing it with Escape leaves the card waiting
 * in Approvals; Not now answers it, which holds that card for 24 hours. While Settings,
 * onboarding or welcome is open it stays mounted and hidden, so an Escape still holds.
 */
export function HealthCardDialog({ suppressed }: { suppressed: boolean }) {
  const items = useNotifyStore(selectNotifyItems);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const card = items.find(item => item.state === 'waiting' && !item.unreachable && isHealthCard(item) && !dismissed.has(item.id));
  if (suppressed || !card || !isHealthCard(card)) return null;
  const close = () => setDismissed(previous => new Set([...previous, card.id]));
  const answer = (choice: string) => {
    answerHealthCard(card, choice);
    close();
  };
  return (
    // Keyed by card: after Escape or an answer, the next waiting card opens as its own dialog.
    <Modal key={card.id} isOpen onClose={close} size="lg" ariaLabel={cardTitle(card)} showCloseButton={false}>
      <div className="p-6">
        <HealthCardBody
          item={card}
          machineName={remoteMachineName(card)}
          onAnswer={answer}
          onAskAgent={() => { void askAgentAbout(card); close(); }}
          onReview={() => { void reviewHealthCard(card); close(); }}
        />
      </div>
    </Modal>
  );
}

