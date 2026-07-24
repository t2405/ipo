import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import './lib/fetch-interceptor';
import App from './Appx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

