import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MediaFilePreview } from '../../frontend/src/components/panels/editor/MediaFilePreview';

const pending: Array<(url: string) => void> = [];
const released: string[] = [];
let issued = 0;
let notify = () => {};
Object.assign(window, {
  electronAPI: {
    invoke: async (channel: string, url: string) => {
      if (channel === 'file:preview-url') return new Promise<string>(resolve => { pending.push(resolve); notify(); });
      if (channel === 'file:release-preview') { released.push(url); notify(); return; }
      throw new Error(`Unexpected IPC: ${channel}`);
    },
  },
});

function Fixture() {
  const [shown, setShown] = useState(true);
  const [, rerender] = useState(0);
  notify = () => rerender(value => value + 1);
  return <>
    <button onClick={() => setShown(false)}>Unmount preview</button>
    <button onClick={() => setShown(true)}>Mount preview</button>
    <button onClick={() => { pending.shift()?.(`https://preview.test/grant-${++issued}`); notify(); }}>Resolve grant</button>
    <output aria-label="Pending grants">{pending.length}</output>
    <output aria-label="Released grants">{JSON.stringify(released)}</output>
    {shown && <MediaFilePreview sessionId="test-session" filePath="clip.mp4" fileName="clip.mp4" kind="video" />}
  </>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
