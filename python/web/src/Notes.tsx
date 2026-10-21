// The Notes example at /notes (SPEC.md APP-7): sign in, keep notes, and get an email for each one. It shows every piece
// of the starter working together, and it's yours to remove once your app takes shape.
import { type FormEvent, useEffect, useState } from 'react';
import { api, type Note, type User } from './api.ts';

export function Notes() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [app, setApp] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.me().then((r) => setUser(r.data?.user ?? null));
    void api.welcome().then((r) => setApp(r.data?.app ?? ''));
  }, []);
  useEffect(() => {
    if (user) void api.notes().then((r) => setNotes(r.data ?? []));
  }, [user]);

  async function add(title: string) {
    const r = await api.add(title);
    if (r.data) { setNotes([r.data, ...notes]); setError(''); return true; }
    setError(r.error ?? 'Couldn’t save the note.');
    return false;
  }
  return <NotesView app={app} user={user} notes={notes} error={error} onAdd={add} onSignOut={() => void api.signOut().then(() => setUser(null))} />;
}

// The page from its state alone, so it renders the same in the browser and in conformance (CONF:welcome-copy).
export function NotesView({ app, user, notes, error, onAdd, onSignOut }: {
  app: string; user: User | null | undefined; notes: Note[]; error: string; onAdd: (title: string) => Promise<boolean>; onSignOut: () => void;
}) {
  const [title, setTitle] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await onAdd(title)) setTitle('');
  }
  return (
    <>
      <div className="ribbon">
        <div className="wrap">
          <span><span className="tag">Example</span>Part of the starter. Your agent removes it once your app takes shape.</span>
          <a href="/">← {app || 'Back'}</a>
        </div>
      </div>
      <main className="wrap notes-page">
        {user === undefined ? null : !user ? (
          <section className="signin">
            <h1 className="title">Your notes</h1>
            <p>Sign in to keep notes. Each new note sends you an email.</p>
            <a className="btn btn-cream" href="/auth/sign-in?return_to=/notes">Sign in</a>
          </section>
        ) : (
          <>
            <div className="notes-head">
              <div>
                <h1>Your notes</h1>
                <p>Signed in as {user.name ?? user.email ?? 'you'}. Each new note sends you an email.</p>
              </div>
              <button type="button" className="btn btn-ghost" onClick={onSignOut}>Sign out</button>
            </div>
            <form className="add" onSubmit={(e) => void submit(e)}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A new note" maxLength={200} aria-label="Note title" />
              <button className="btn btn-cream" disabled={!title.trim()}>Add note</button>
            </form>
            {error && <p className="error" role="alert">{error}</p>}
            <ul className="card list">
              {notes.map((n) => <li key={n.id}><span>{n.title}</span><time dateTime={n.created_at}>{new Date(n.created_at).toLocaleString()}</time></li>)}
              {!notes.length && <li className="muted">No notes yet.</li>}
            </ul>
            <div className="how">
              <div><code><span className="stripe" style={{ width: 4, height: 14, background: 'var(--pink)', transform: 'skewX(-13deg)', display: 'inline-block' }} />POST /api/notes</code><p>Saves the note and queues its email in one transaction.</p></div>
              <div><code><span className="stripe" style={{ width: 4, height: 14, background: 'var(--blue)', transform: 'skewX(-13deg)', display: 'inline-block' }} />worker: note_email</code><p>Sends it through agent.cloud, then logs <code style={{ display: 'inline' }}>note.emailed</code>.</p></div>
              <div><code>check: a title once per person</code><p>An invariant agc runs before every release.</p></div>
            </div>
          </>
        )}
      </main>
    </>
  );
}
