import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { bootstrapStorage } from './lib/bootstrap';

/**
 * Boot order matters: ask for persistent storage and run the on-open weekly
 * snapshot BEFORE React paints, so the very first render already knows whether
 * storage is protected. Never blocks rendering on failure.
 */
void bootstrapStorage();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found in index.html');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
