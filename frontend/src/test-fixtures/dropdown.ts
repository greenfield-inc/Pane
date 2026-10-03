import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dropdown, DropdownMenuItem } from '../components/ui/Dropdown';

// Render the production component with states that product menus do not always
// expose (disabled rows before a selected row, and a menu kept open on select).
export function renderDropdown({ selectedId = 'c', closeOnSelect = true, width = 'md' }: {
  selectedId?: string;
  closeOnSelect?: boolean;
  width?: 'md' | 'full';
} = {}) {
  document.getElementById('root')?.setAttribute('hidden', '');
  const container = document.createElement('div');
  container.style.cssText = 'padding: 32px; width: 360px;';
  document.body.appendChild(container);

  function Fixture() {
    const [selection, setSelection] = useState(selectedId);
    const [action, setAction] = useState('none');
    return createElement('div', null,
      createElement(Dropdown, {
        trigger: createElement('button', { type: 'button', style: { width: 180 } }, 'Choose option'),
        selectedId: selection,
        width,
        closeOnSelect,
        items: [
          { id: 'a', label: 'Unavailable', disabled: true },
          { id: 'b', label: 'Bravo', onClick: () => { setSelection('b'); setAction('b'); } },
          { id: 'c', label: 'Charlie', onClick: () => { setSelection('c'); setAction('c'); } },
        ],
        footer: createElement(DropdownMenuItem, { label: 'Configure', onClick: () => setAction('footer') }),
      }),
      createElement('button', { type: 'button', style: { marginTop: 240 } }, 'Outside control'),
      createElement('output', { 'aria-label': 'Last action' }, action),
    );
  }
  createRoot(container).render(createElement(Fixture));
}
