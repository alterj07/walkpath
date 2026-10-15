/**
 * Profile page: resume upload parsed in the browser (pdfjs, lazy-loaded) that
 * fills an editable form; saved to localStorage only. Nothing is uploaded.
 */
import { useEffect, useRef, useState } from 'react';
import { FAMILIES, FAMILY_LABELS, US_STATES, type Family } from '../lib/data.ts';
import { DEGREE_LEVELS, EMPTY_PROFILE, MAX_SKILLS, clearProfile, getProfile, hasProfile, saveProfile, type Profile, type ProfileDegree } from '../lib/profile.ts';
import { degreeLabel } from '../lib/match.ts';

const YEARS = Array.from({ length: 10 }, (_, i) => 2025 + i);

function listFromText(s: string, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of s.split(/[,;\n]/)) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t.slice(0, 60));
    if (out.length >= max) break;
  }
  return out;
}

type Tri = 'unknown' | 'yes' | 'no';
const toTri = (v: boolean | null): Tri => (v === null ? 'unknown' : v ? 'yes' : 'no');
const fromTri = (v: string): boolean | null => (v === 'yes' ? true : v === 'no' ? false : null);

export function ProfilePage() {
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [skillsText, setSkillsText] = useState('');
  const [majorsText, setMajorsText] = useState('');
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = getProfile();
    setProfile(p);
    setSkillsText(p.skills.join(', '));
    setMajorsText(p.majors.join(', '));
  }, []);

  const update = (patch: Partial<Profile>) => setProfile((p) => ({ ...p, ...patch }));

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setStatus('Reading your resume in this browser…');
    try {
      const { extractResumeText, parseResume } = await import('../lib/resume.ts');
      const text = await extractResumeText(file);
      const found = parseResume(text);
      const keys = Object.keys(found);
      if (keys.length === 0) {
        setStatus('No education, graduation year or skills were recognized. Fill the form by hand.');
      } else {
        const next = { ...profile, ...found };
        setProfile(next);
        if (found.skills) setSkillsText(found.skills.join(', '));
        if (found.majors) setMajorsText(found.majors.join(', '));
        setParsed(keys);
        setStatus(`Filled ${keys.length} field${keys.length === 1 ? '' : 's'} from the resume. Review and save.`);
      }
    } catch (err) {
      setStatus(err instanceof Error && err.message.includes('5 MB') ? err.message : 'Could not read that file. Try a PDF or a plain-text export.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function onSave() {
    const saved = saveProfile({ ...profile, skills: listFromText(skillsText, MAX_SKILLS), majors: listFromText(majorsText, 10) });
    setProfile(saved);
    setSkillsText(saved.skills.join(', '));
    setMajorsText(saved.majors.join(', '));
    setStatus('Saved on this device.');
  }

  function onClear() {
    clearProfile();
    setProfile({ ...EMPTY_PROFILE });
    setSkillsText('');
    setMajorsText('');
    setParsed([]);
    setStatus('Profile cleared.');
  }

  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="profile">
      <section className="callout" aria-labelledby="resume-h">
        <h2 id="resume-h">Fill from your resume</h2>
        <p className="small">PDF or plain text. It is parsed in your browser and never uploaded; only the fields below are kept, on this device.</p>
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files[0]); }}
        >
          <button type="button" className="chip" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Reading…' : 'Choose resume'}</button>
          <span className="small muted"> or drop a file here</span>
          <input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" className="visually-hidden" tabIndex={-1} aria-hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        {status && <p className="small" aria-live="polite">{status}</p>}
      </section>

      <form className="profile-form" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
        <fieldset>
          <legend>Education</legend>
          <label>
            Graduation year{parsed.includes('grad_year') && <span className="badge"> from resume</span>}
            <select value={profile.grad_year ?? ''} onChange={(e) => update({ grad_year: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Not set</option>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label>
            Current or expected degree
            <select value={profile.degree_level ?? ''} onChange={(e) => update({ degree_level: (e.target.value || null) as ProfileDegree | null })}>
              <option value="">Not set</option>
              {DEGREE_LEVELS.map((d) => <option key={d} value={d}>{degreeLabel(d)}</option>)}
            </select>
          </label>
          <label>
            Currently enrolled
            <select value={toTri(profile.enrolled)} onChange={(e) => update({ enrolled: fromTri(e.target.value) })}>
              <option value="unknown">Not set</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label>
            Majors (comma-separated)
            <input type="text" value={majorsText} maxLength={600} onChange={(e) => setMajorsText(e.target.value)} />
          </label>
        </fieldset>

        <fieldset>
          <legend>Skills</legend>
          <label>
            Comma-separated (up to {MAX_SKILLS})
            <textarea rows={3} value={skillsText} maxLength={6000} onChange={(e) => setSkillsText(e.target.value)} />
          </label>
        </fieldset>

        <fieldset>
          <legend>Role families</legend>
          <div className="chips">
            {FAMILIES.map((f) => (
              <button key={f} type="button" className={profile.families.includes(f) ? 'chip chip-on' : 'chip'} aria-pressed={profile.families.includes(f)} onClick={() => update({ families: toggleIn(profile.families, f) as Family[] })}>
                {FAMILY_LABELS[f]}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Location</legend>
          <label className="inline">
            <input type="checkbox" checked={profile.remote_ok} onChange={(e) => update({ remote_ok: e.target.checked })} /> Open to remote roles
          </label>
          <label>
            Preferred states
            <select multiple size={6} value={profile.states} onChange={(e) => update({ states: Array.from(e.target.selectedOptions, (o) => o.value) })}>
              {Object.entries(US_STATES).map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
            </select>
          </label>
        </fieldset>

        <fieldset>
          <legend>Work authorization</legend>
          <label>
            US citizen
            <select value={toTri(profile.citizen)} onChange={(e) => update({ citizen: fromTri(e.target.value) })}>
              <option value="unknown">Prefer not to say</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label>
            Will need visa sponsorship
            <select value={toTri(profile.needs_sponsorship)} onChange={(e) => update({ needs_sponsorship: fromTri(e.target.value) })}>
              <option value="unknown">Prefer not to say</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <p className="small muted">Used only to hide postings that require citizenship or do not sponsor. Leave unset and nothing is hidden for these reasons.</p>
        </fieldset>

        <div className="tracker-controls">
          <button type="submit" className="chip chip-on">Save profile</button>
          <button type="button" className="chip" onClick={onClear}>Clear my profile</button>
          {hasProfile(profile) && <a className="chip" href="/for-you">See jobs for you</a>}
        </div>
      </form>
    </div>
  );
}
