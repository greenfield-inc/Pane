import React from 'react';
import ReactDOM from 'react-dom/client';
import { NotifyWindow } from './components/notify/NotifyWindow';
import './index.css';

const params = new URLSearchParams(window.location.search);
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <NotifyWindow view={params.get('view') === 'round' ? 'round' : 'strip'} startId={params.get('id') ?? undefined} />
  </React.StrictMode>,
);
