/**
 * Sign-in flows. Only redirect-based Google sign-in and passwordless email links are offered:
 * no popups, no frames (the CSP sets frame-ancestors 'none' and allows no frame-src), no passwords.
 *
 * The redirect flow navigates to `https://<authDomain>/__/auth/handler` and back; `authDomain`
 * must be the project's default `<project>.firebaseapp.com` or a custom domain configured in
 * Firebase, and the site's hostname must be listed under Authentication → Settings → Authorized
 * domains (see docs/accounts.md).
 */
import type { User } from 'firebase/auth';
import { getFirebase } from './firebase.ts';

export interface AccountUser {
  uid: string;
  email: string | null;
}

const EMAIL_FOR_LINK = 'walkpath:emailForSignIn';

function toAccountUser(u: User | null | undefined): AccountUser | null {
  return u ? { uid: u.uid, email: u.email } : null;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i.test(email.trim());
}

export async function signInWithGoogle(): Promise<void> {
  const { auth } = await getFirebase();
  const { GoogleAuthProvider, signInWithRedirect } = await import('firebase/auth');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await signInWithRedirect(auth, provider);
}

/** Finishes a Google redirect when the page loads after returning from the provider. */
export async function completeRedirect(): Promise<AccountUser | null> {
  const { auth } = await getFirebase();
  const { getRedirectResult } = await import('firebase/auth');
  const result = await getRedirectResult(auth).catch(() => null);
  return toAccountUser(result?.user ?? auth.currentUser);
}

export async function sendEmailLink(email: string): Promise<void> {
  if (!isValidEmail(email)) throw new Error('invalid email');
  const { auth } = await getFirebase();
  const { sendSignInLinkToEmail } = await import('firebase/auth');
  await sendSignInLinkToEmail(auth, email.trim(), { url: `${location.origin}/account`, handleCodeInApp: true });
  try {
    sessionStorage.setItem(EMAIL_FOR_LINK, email.trim());
  } catch {
    // the address can be retyped on the account page
  }
}

export function pendingEmailForLink(): string | null {
  try {
    return sessionStorage.getItem(EMAIL_FOR_LINK);
  } catch {
    return null;
  }
}

/** True when the current URL is a Firebase email sign-in link. */
export async function isEmailLink(): Promise<boolean> {
  const { auth } = await getFirebase();
  const { isSignInWithEmailLink } = await import('firebase/auth');
  return isSignInWithEmailLink(auth, location.href);
}

/** On /account: completes an email-link sign-in when the current URL carries one. */
export async function completeEmailLink(email?: string): Promise<AccountUser | null> {
  const { auth } = await getFirebase();
  const { isSignInWithEmailLink, signInWithEmailLink } = await import('firebase/auth');
  if (!isSignInWithEmailLink(auth, location.href)) return null;
  const addr = (email ?? pendingEmailForLink() ?? '').trim();
  if (!isValidEmail(addr)) throw new Error('email required');
  const cred = await signInWithEmailLink(auth, addr, location.href);
  try {
    sessionStorage.removeItem(EMAIL_FOR_LINK);
    history.replaceState(null, '', '/account');
  } catch {
    // cosmetic only
  }
  return toAccountUser(cred.user);
}

export async function signOut(): Promise<void> {
  const { auth } = await getFirebase();
  const { signOut: fbSignOut } = await import('firebase/auth');
  await fbSignOut(auth);
}

/** Deletes the user's Firestore document and the auth user. Firebase may ask for a recent sign-in. */
export async function deleteAccount(): Promise<void> {
  const { auth, db } = await getFirebase();
  const user = auth.currentUser;
  if (!user) return;
  const { deleteDoc, doc } = await import('firebase/firestore');
  const { deleteUser } = await import('firebase/auth');
  await deleteDoc(doc(db, 'users', user.uid));
  await deleteUser(user);
}

/** Subscribes to auth state; resolves to an unsubscribe function. */
export async function onUser(cb: (user: AccountUser | null) => void): Promise<() => void> {
  const { auth } = await getFirebase();
  const { onAuthStateChanged } = await import('firebase/auth');
  return onAuthStateChanged(auth, (u) => cb(toAccountUser(u)));
}
