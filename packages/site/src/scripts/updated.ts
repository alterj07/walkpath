/**
 * Fills the header's "Updated N min ago" indicator from /data/meta.json so
 * visitors can see the hourly cadence is real (plan section 5.4). Emitted as
 * an external module by Astro; nothing here is inline.
 */
import { loadMeta, relativeTime } from '../lib/data.ts';

const el = document.querySelector<HTMLElement>('[data-updated-at]');

if (el) {
  loadMeta()
    .then((meta) => {
      if (!meta) return;
      el.textContent = `Updated ${relativeTime(meta.last_run_at, Date.now())}`;
      el.title = `Last run ${meta.last_run_at}`;
      el.hidden = false;
    })
    .catch(() => {
      // The indicator is decorative; a failed fetch leaves it hidden.
    });
}
