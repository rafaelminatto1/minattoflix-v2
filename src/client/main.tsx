import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Register Service Worker for PWA/Offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      console.log('[SW] Registered:', registration.scope);
      
      // Check for updates periodically
      setInterval(() => registration.update(), 60 * 60 * 1000);
      
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New version available - show update prompt
              console.log('[SW] New version available');
              if (confirm('Nova versão disponível! Recarregar?')) {
                window.location.reload();
              }
            }
          });
        }
      });
    }).catch((error) => {
      console.warn('[SW] Registration failed:', error);
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>
);
