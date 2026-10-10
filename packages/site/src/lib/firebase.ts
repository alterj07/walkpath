/**
 * Optional accounts: Firebase Authentication + Cloud Firestore on the free Spark plan.
 *
 * The site works fully without an account (localStorage stays the source of truth); signing in
 * only adds sync across devices. The four PUBLIC_FIREBASE_* values are public by design (they
 * identify the project; Firestore security rules protect the data). When any of them is unset,
 * `accountsEnabled()` is false and no Firebase code is ever loaded.
 */
import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

function buildEnv(): Record<string, string | undefined> {
  try {
    return (import.meta.env ?? {}) as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

export function firebaseConfig(source: Record<string, string | undefined> = buildEnv()): FirebaseConfig | null {
  const apiKey = source.PUBLIC_FIREBASE_API_KEY?.trim() ?? '';
  const authDomain = source.PUBLIC_FIREBASE_AUTH_DOMAIN?.trim() ?? '';
  const projectId = source.PUBLIC_FIREBASE_PROJECT_ID?.trim() ?? '';
  const appId = source.PUBLIC_FIREBASE_APP_ID?.trim() ?? '';
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(apiKey)) return null;
  if (!/^[a-z0-9.-]{3,253}$/i.test(authDomain)) return null;
  if (!/^[a-z0-9-]{4,40}$/.test(projectId)) return null;
  if (!/^[0-9]+:[0-9]+:web:[a-f0-9]+$/i.test(appId)) return null;
  return { apiKey, authDomain, projectId, appId };
}

export function accountsEnabled(source?: Record<string, string | undefined>): boolean {
  return firebaseConfig(source) !== null;
}

export interface FirebaseHandles {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

let handles: Promise<FirebaseHandles> | null = null;

/** Lazily loads the SDK (its own chunk) and initialises the app once. */
export function getFirebase(): Promise<FirebaseHandles> {
  if (!handles) {
    handles = (async () => {
      const cfg = firebaseConfig();
      if (!cfg) throw new Error('accounts are not configured');
      const [{ initializeApp, getApps, getApp }, { getAuth }, { getFirestore }] = await Promise.all([
        import('firebase/app'),
        import('firebase/auth'),
        import('firebase/firestore'),
      ]);
      const app = getApps().length ? getApp() : initializeApp(cfg);
      return { app, auth: getAuth(app), db: getFirestore(app) };
    })();
  }
  return handles;
}
