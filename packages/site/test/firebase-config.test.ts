import { describe, expect, it } from 'vitest';
import { accountsEnabled, firebaseConfig } from '../src/lib/firebase.ts';

const good = {
  PUBLIC_FIREBASE_API_KEY: 'AIzaSyA0123456789abcdefghijklmnopqrstuvw',
  PUBLIC_FIREBASE_AUTH_DOMAIN: 'walkpath-demo.firebaseapp.com',
  PUBLIC_FIREBASE_PROJECT_ID: 'walkpath-demo',
  PUBLIC_FIREBASE_APP_ID: '1:123456789012:web:abcdef0123456789',
};

describe('accountsEnabled', () => {
  it('is false without the four public values (and in plain Node)', () => {
    expect(accountsEnabled({})).toBe(false);
    expect(accountsEnabled({ ...good, PUBLIC_FIREBASE_APP_ID: '' })).toBe(false);
    expect(accountsEnabled()).toBe(false);
  });

  it('is true with well-formed values and rejects malformed ones', () => {
    expect(accountsEnabled(good)).toBe(true);
    expect(firebaseConfig(good)).toEqual({
      apiKey: good.PUBLIC_FIREBASE_API_KEY,
      authDomain: good.PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: 'walkpath-demo',
      appId: good.PUBLIC_FIREBASE_APP_ID,
    });
    expect(accountsEnabled({ ...good, PUBLIC_FIREBASE_AUTH_DOMAIN: 'evil.com/<script>' })).toBe(false);
    expect(accountsEnabled({ ...good, PUBLIC_FIREBASE_APP_ID: 'not-an-app-id' })).toBe(false);
  });
});
