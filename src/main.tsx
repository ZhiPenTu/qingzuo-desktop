import React from 'react';
import ReactDOM from 'react-dom/client';
import Platform from './platform/Platform';
import { ErrorBoundary } from './platform/ErrorBoundary';
import { initGlobalErrorTracking } from './platform/error-tracker';
import { ThemeProvider } from './theme/ThemeProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import './styles.css';

initGlobalErrorTracking();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ThemeProvider><TooltipProvider><ErrorBoundary><Platform /></ErrorBoundary></TooltipProvider></ThemeProvider></React.StrictMode>,
);
