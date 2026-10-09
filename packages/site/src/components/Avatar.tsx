/** Company logo from Brandfetch when configured, else a letter avatar. */
import { useState } from 'react';
import { logoUrl } from '../lib/data.ts';

export function Avatar({ name, domain, size = 28 }: { name: string; domain: string; size?: number }) {
  const url = logoUrl(domain);
  const [broken, setBroken] = useState(false);
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  if (url && !broken) {
    return <img className="avatar" src={url} alt="" width={size} height={size} loading="lazy" onError={() => setBroken(true)} />;
  }
  return <span className="avatar avatar-letter" aria-hidden="true">{letter}</span>;
}
