import type { JobRecord } from '../../src/schema/job.ts';

/** A valid published record for publish-side tests; override any field. */
export function makeRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'a9f3c2e17b04',
    title: 'Flight Software Intern Summer 2027',
    title_raw: 'Flight Software Intern Summer 2027 (REQ-1)',
    company: { slug: 'rocket-lab', name: 'Rocket Lab', domain: 'rocketlabcorp.com' },
    location: { raw: 'Littleton, Colorado', city: 'Littleton', state: 'CO', country: 'US', arrangement: 'in_person', others: [] },
    source: { ats: 'greenhouse', board: 'rocketlab', external_id: '12345' },
    apply_url: 'https://boards.greenhouse.io/rocketlab/jobs/12345',
    apply_url_downgraded: false,
    posted_at: '2026-10-09T14:14:00.000Z',
    posted_at_source: 'ATS_FIELD',
    first_seen_at: '2026-10-09T14:31:07.000Z',
    last_seen_at: '2026-10-09T15:17:40.000Z',
    closed_at: null,
    employment_type: 'internship',
    role_family: 'hardware_embedded',
    season: 'Summer 2027',
    salary: { min: 27, max: 27, currency: 'USD', period: 'hour' },
    citizenship_required: true,
    sponsorship: 'no',
    grad_years: [2027, 2028],
    education: null,
    summary: {
      text: 'Build flight software in C++ & Rust. Work with the avionics team.',
      responsibilities: ['Write flight code'],
      qualifications: ['C++'],
      must_have_skills: ['C++', 'Rust'],
      nice_to_have_skills: [],
      model: 'mistral-small',
      generated_at: '2026-10-09T14:33:02.000Z',
    },
    description_html: '<p>Rust &amp; C++ <strong>flight</strong> software.</p>',
    content_hash: '8f1c8f1c8f1c8f1c8f1c8f1c8f1c8f1c',
    ...overrides,
  };
}
