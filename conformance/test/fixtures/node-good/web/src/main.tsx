import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Notes } from './Notes.tsx';

const Page = location.pathname === '/notes' ? Notes : App;
createRoot(document.getElementById('root')!).render(<Page />);
