import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { internshipGate } from '../../src/gates/internship.ts';
import { techGate } from '../../src/gates/tech.ts';

interface Labelled {
  title: string;
  employment_type?: string;
  is_internship: boolean;
  /** A role family, 'not_tech', or null when the title alone cannot be labelled (unscored for tech). */
  family: string | null;
  source: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'titles', 'labelled.json'), 'utf8')) as Labelled[];

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

describe('gate evaluation on labelled titles', () => {
  it('has at least 500 labelled titles', () => {
    expect(rows.length).toBeGreaterThanOrEqual(500);
  });

  it('internship gate: precision >= 95% (ambiguous is neither a hit nor a false positive)', () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let ambiguous = 0;
    const misses: string[] = [];
    for (const r of rows) {
      const v = internshipGate({ title: r.title, employmentType: r.employment_type ?? null }).verdict;
      if (v === 'ambiguous') {
        ambiguous++;
        if (r.is_internship) fn++;
        continue;
      }
      const predicted = v === 'intern';
      if (predicted && r.is_internship) tp++;
      else if (predicted && !r.is_internship) {
        fp++;
        misses.push(`FP ${r.title}`);
      } else if (!predicted && r.is_internship) {
        fn++;
        misses.push(`FN ${r.title}`);
      }
    }
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    console.log(
      `internship gate: tp=${tp} fp=${fp} fn=${fn} ambiguous=${ambiguous} precision=${pct(tp, tp + fp)} recall=${pct(tp, tp + fn)}`,
    );
    console.log(misses.slice(0, 20).join('\n'));
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });

  it('tech gate: precision >= 90% and recall >= 85% on tech vs not-tech (ambiguous counts as a miss)', () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    let ambiguous = 0;
    let familyAgree = 0;
    const misses: string[] = [];
    const familyMisses: string[] = [];
    for (const r of rows) {
      if (r.family === null) continue;
      const g = techGate(r.title);
      const isTech = r.family !== 'not_tech';
      if (g.verdict === 'ambiguous') {
        ambiguous++;
        if (isTech) {
          fn++;
          misses.push(`FN(ambiguous) ${r.title} [${r.family}]`);
        }
        continue;
      }
      const predicted = g.verdict === 'tech';
      if (predicted && isTech) {
        tp++;
        if (g.family === r.family) familyAgree++;
        else familyMisses.push(`${r.title}: expected ${r.family}, got ${g.family}`);
      } else if (predicted && !isTech) {
        fp++;
        misses.push(`FP ${r.title} -> ${g.family} (${g.matched})`);
      } else if (!predicted && isTech) {
        fn++;
        misses.push(`FN ${r.title} [${r.family}] (${g.matched})`);
      } else tn++;
    }
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    console.log(
      `tech gate: tp=${tp} fp=${fp} fn=${fn} tn=${tn} ambiguous=${ambiguous} precision=${pct(tp, tp + fp)} recall=${pct(tp, tp + fn)} family-agreement=${pct(familyAgree, tp)}`,
    );
    console.log('worst misses:\n' + misses.slice(0, 20).join('\n'));
    console.log('family disagreements (first 20):\n' + familyMisses.slice(0, 20).join('\n'));
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.85);
    // Family boundaries (embedded software vs hardware, data infra vs software) are fuzzy by nature.
    expect(familyAgree / tp).toBeGreaterThanOrEqual(0.8);
  });
});
