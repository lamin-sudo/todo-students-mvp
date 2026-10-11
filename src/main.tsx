import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { bootstrapStorage, listenForBackupRequests } from './lib/bootstrap';
// side-effect import: the beforeinstallprompt listener must exist before the
// event can fire, which is earlier than any component mounts.
import './lib/install';

/**
 * Boot order matters: ask for persistent storage and run the on-open weekly
 * snapshot BEFORE React paints, so the very first render already knows whether
 * storage is protected. Never blocks rendering on failure.
 */
void bootstrapStorage();
// the periodic-sync ping from the service worker lands here
listenForBackupRequests();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found in index.html');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
