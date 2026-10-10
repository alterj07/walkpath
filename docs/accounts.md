# Optional accounts

Accounts exist only so saved jobs and the profile can follow a student across devices. The site
works fully without one: `localStorage` stays the source of truth on every device, and signing in
merges it with one document per user in Cloud Firestore. Nothing else is stored, and no resume file
is ever uploaded.

| Stored | Firestore document `users/{uid}` field |
| --- | --- |
| Tracker (job id, stage, date, your note) | `walkpath:tracker` |
| Profile (graduation year, degree, majors, skills, preferences) | `walkpath:profile` |
| Last write time | `updated_at` |

Provider: Firebase Authentication (Google sign-in by redirect, passwordless email link) and Cloud
Firestore on the free Spark plan. No card is needed. Cloud Storage is not used because it is not
free on new projects.

## How the code works

- `src/lib/firebase.ts`: `accountsEnabled()` is true only when the four `PUBLIC_FIREBASE_*` values
  are set at build time; the SDK is imported lazily, so pages that never open the account menu do
  not download it.
- `src/lib/auth.ts`: `signInWithGoogle()` (redirect flow, no popups or frames), `sendEmailLink()`
  and `completeEmailLink()` (finished on `/account`), `signOut()`, `deleteAccount()`, `onUser()`.
- `src/lib/sync.ts`: on sign-in, reads `users/{uid}`, merges with `localStorage` (newest entry
  wins; a local note is never erased), writes the result back to both, then re-uploads one second
  after any `walkpath:changed` event. `tracker.ts` dispatches that event after each write; the
  profile module should dispatch the same event (`CustomEvent('walkpath:changed')`) after it saves.
- Everything read from Firestore is treated as untrusted and goes through `sanitizeTracker` and the
  profile validator before use.
- `firebase/firestore.rules`: only the signed-in user can read or write their own document, only the
  three field names above are accepted, and documents must stay under 1 MB. Everything else is denied.

## One-time setup (owner)

1. Create a Firebase project at https://console.firebase.google.com (free Spark plan).
2. Build → Authentication → Get started → Sign-in method: enable **Google** and **Email/Password**
   with **Email link (passwordless sign-in)** switched on.
3. Authentication → Settings → Authorized domains: add `walkpath.vercel.app` (and any custom
   domain). `localhost` is already listed for `astro dev`.
4. Build → Firestore Database → Create database → production mode, any region.
5. Rules tab → paste the contents of `packages/site/firebase/firestore.rules` → Publish (or run
   `npx firebase-tools deploy --only firestore:rules` from `packages/site/firebase` after
   `npx firebase-tools login`).
6. Project settings → General → Your apps → Add app → Web. Copy `apiKey`, `authDomain`,
   `projectId`, `appId` into these variables:

   | Variable | Where |
   | --- | --- |
   | `PUBLIC_FIREBASE_API_KEY` | Vercel → Project → Settings → Environment Variables; GitHub → Settings → Secrets and variables → Actions → Variables |
   | `PUBLIC_FIREBASE_AUTH_DOMAIN` | same (use the default `<project>.firebaseapp.com`) |
   | `PUBLIC_FIREBASE_PROJECT_ID` | same |
   | `PUBLIC_FIREBASE_APP_ID` | same |

   These values are public by design (they appear in the site's JavaScript); the security rules,
   not the keys, protect the data. Redeploy the site after setting them.
7. Visit the site, open "Sign in" in the header, and sign in with Google once to confirm the redirect
   returns to the site and the status reads "Synced".

## Content Security Policy

`connect-src` allows `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`,
`firestore.googleapis.com`, `www.googleapis.com` and `*.firebaseapp.com`. The SDK is bundled from
our origin, so `script-src` is unchanged; the redirect flow is a top-level navigation, so no frames
are needed and `frame-ancestors 'none'` stays.

## Deleting an account

The Account page's "Delete my account" removes the Firestore document and the sign-in. Firebase may
require a recent sign-in for the second step; the page says so. Browser data is kept until the
student clears it on the Saved page.
