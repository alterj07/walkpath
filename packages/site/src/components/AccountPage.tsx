import { useEffect, useState } from 'react';
import { accountsEnabled } from '../lib/firebase.ts';
import type { AccountUser } from '../lib/auth.ts';
import { getTracker } from '../lib/tracker.ts';

/**
 * /account: completes email-link sign-ins, shows what the account stores, and offers deletion.
 * Nothing here renders HTML from data; all values are text nodes.
 */
export default function AccountPage() {
  const enabled = accountsEnabled();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [ready, setReady] = useState(false);
  const [needEmail, setNeedEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [counts, setCounts] = useState({ tracker: 0, profile: false });

  const refreshCounts = () => {
    let profile = false;
    try {
      profile = Boolean(globalThis.localStorage?.getItem('walkpath:profile'));
    } catch {
      profile = false;
    }
    setCounts({ tracker: Object.keys(getTracker()).length, profile });
  };

  useEffect(() => {
    refreshCounts();
    if (!enabled) {
      setReady(true);
      return;
    }
    let unsub: (() => void) | null = null;
    (async () => {
      try {
        const auth = await import('../lib/auth.ts');
        if (await auth.isEmailLink()) {
          try {
            const u = await auth.completeEmailLink();
            if (u) setMessage('Signed in with your email link.');
          } catch {
            setNeedEmail(true);
          }
        }
        unsub = await auth.onUser((u) => {
          setUser(u);
          setReady(true);
        });
      } catch {
        setReady(true);
      }
    })();
    return () => unsub?.();
  }, [enabled]);

  if (!enabled) {
    return (
      <p>
        Accounts are not enabled on this deployment. Your saved jobs and profile stay in this browser; use the
        export on the Saved page to move them between devices.
      </p>
    );
  }
  if (!ready) return <p aria-live="polite">Loading…</p>;

  const finishEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const auth = await import('../lib/auth.ts');
      const u = await auth.completeEmailLink(email);
      setNeedEmail(false);
      setMessage(u ? 'Signed in with your email link.' : 'This link is not a sign-in link.');
    } catch {
      setMessage('That email does not match the link. Request a new link from the header.');
    }
  };

  return (
    <div className="account-page">
      {needEmail && (
        <form onSubmit={finishEmail} className="card">
          <p>Confirm the email address you requested the sign-in link for.</p>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="email" />
          </label>
          <button type="submit" className="chip chip-on">Finish sign-in</button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
      {user ? (
        <>
          <p>
            Signed in as <strong>{user.email ?? user.uid}</strong>.
          </p>
          <h2>What your account stores</h2>
          <ul>
            <li>Saved and applied jobs: {counts.tracker} entries (stage, date, your note).</li>
            <li>Profile: {counts.profile ? 'saved on this device and synced' : 'not set'} (graduation year, degree, skills, preferences).</li>
            <li>Nothing else. No resume file, no history, no analytics tied to you.</li>
          </ul>
          <h2>Delete my account</h2>
          <p>Removes the synced document and the sign-in. Data in this browser is kept until you clear it on the Saved page.</p>
          {confirmDelete ? (
            <div role="group" aria-label="Confirm deletion">
              <button
                type="button"
                className="chip"
                onClick={async () => {
                  try {
                    const auth = await import('../lib/auth.ts');
                    await auth.deleteAccount();
                    setMessage('Account deleted.');
                  } catch {
                    setMessage('Deletion needs a recent sign-in. Sign out, sign in again, then retry.');
                  }
                  setConfirmDelete(false);
                }}
              >
                Yes, delete
              </button>
              <button type="button" className="chip" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="chip" onClick={() => setConfirmDelete(true)}>Delete my account</button>
          )}
        </>
      ) : (
        <p>You are not signed in. Use the Sign in control in the header. Accounts are optional.</p>
      )}
    </div>
  );
}
