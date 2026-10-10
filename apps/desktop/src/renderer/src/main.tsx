import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import 'katex/dist/katex.min.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('renderer: #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
