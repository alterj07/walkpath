import { useEffect, useRef, useState } from 'react';
import { accountsEnabled } from '../lib/firebase.ts';
import type { AccountUser } from '../lib/auth.ts';

/**
 * Header island for the optional account. Renders nothing unless the four PUBLIC_FIREBASE_*
 * values are set at build time; the Firebase SDK is only loaded after that check passes.
 * Every string shown comes from our own code or the user's email as a text node.
 */
type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string };

export default function AccountMenu() {
  const enabled = accountsEnabled();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' });
  const stopWatch = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const auth = await import('../lib/auth.ts');
        await auth.completeRedirect();
        unsub = await auth.onUser(async (u) => {
          if (cancelled) return;
          setUser(u);
          setReady(true);
          stopWatch.current?.();
          stopWatch.current = null;
          if (u) {
            try {
              const sync = await import('../lib/sync.ts');
              const store = await sync.firestoreStore();
              setStatus({ kind: 'busy', text: 'Syncing…' });
              await sync.syncNow(u.uid, store);
              setStatus({ kind: 'ok', text: `Synced ${new Date().toLocaleTimeString()}` });
              stopWatch.current = sync.watchChanges(u.uid, store, () => setStatus({ kind: 'error', text: 'Sync failed; will retry on next change' }));
            } catch {
              setStatus({ kind: 'error', text: 'Sync failed' });
            }
          }
        });
      } catch {
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      unsub?.();
      stopWatch.current?.();
    };
  }, [enabled]);

  if (!enabled) return null;

  const run = async (label: string, fn: () => Promise<void>) => {
    setStatus({ kind: 'busy', text: `${label}…` });
    try {
      await fn();
      setStatus({ kind: 'ok', text: `${label} done` });
    } catch {
      setStatus({ kind: 'error', text: `${label} failed` });
    }
  };

  if (!ready) return <span className="account" aria-live="polite" />;

  if (user) {
    return (
      <div className="account">
        <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {user.email ?? 'Account'}
        </button>
        {open && (
          <div className="account-menu" role="group" aria-label="Account">
            <button
              type="button"
              className="chip"
              onClick={() =>
                run('Sync', async () => {
                  const sync = await import('../lib/sync.ts');
                  await sync.syncNow(user.uid, await sync.firestoreStore());
                })
              }
            >
              Sync now
            </button>
            <a className="chip" href="/account">Account</a>
            <button
              type="button"
              className="chip"
              onClick={() =>
                run('Sign out', async () => {
                  const auth = await import('../lib/auth.ts');
                  await auth.signOut();
                  setOpen(false);
                })
              }
            >
              Sign out
            </button>
            <p className={`account-status status-${status.kind}`} aria-live="polite">{status.text}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="account">
      <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Sign in
      </button>
      {open && (
        <div className="account-menu" role="group" aria-label="Sign in">
          <p className="muted">Optional. Syncs your saved jobs and profile across devices.</p>
          <button
            type="button"
            className="chip chip-on"
            onClick={() =>
              run('Google sign-in', async () => {
                const auth = await import('../lib/auth.ts');
                await auth.signInWithGoogle();
              })
            }
          >
            Continue with Google
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run('Email link', async () => {
                const auth = await import('../lib/auth.ts');
                await auth.sendEmailLink(email);
                setStatus({ kind: 'ok', text: 'Check your email for the sign-in link' });
              });
            }}
          >
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="email" />
            </label>
            <button type="submit" className="chip">Send sign-in link</button>
          </form>
          <p className={`account-status status-${status.kind}`} aria-live="polite">{status.text}</p>
        </div>
      )}
    </div>
  );
}
