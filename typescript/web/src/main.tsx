import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsPage } from './Agents.tsx';
import { App } from './App.tsx';
import { Notes } from './Notes.tsx';
import './styles.css';

// The pages, one bundle: the server answers index.html for each, so a reload of any works (SPEC.md APP-7). /agents and
// below are the person's controls for their agents (AMCP-6).
const path = location.pathname.replace(/\/+$/, '');
const Page = path === '/notes' ? Notes : path === '/agents' || path.startsWith('/agents/') ? AgentsPage : App;
createRoot(document.getElementById('root')!).render(<StrictMode><Page /></StrictMode>);
