import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import App from './App.jsx';
import './index.css';
import './styles/theme-oc2.css';

// Fase A — activar paleta OC-2 si VITE_FEATURE_NEW_UI=true. Sin el flag, el
// cliente sigue usando el tema legacy navy definido en index.css.
if (import.meta.env.VITE_FEATURE_NEW_UI === 'true') {
  document.documentElement.setAttribute('data-theme-oc2', 'true');
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
