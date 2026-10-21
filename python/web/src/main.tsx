import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Notes } from './Notes.tsx';
import './styles.css';

// Two pages, one bundle: the server answers index.html for both, so a reload of either works (SPEC.md APP-7).
const Page = location.pathname.replace(/\/+$/, '') === '/notes' ? Notes : App;
createRoot(document.getElementById('root')!).render(<StrictMode><Page /></StrictMode>);
