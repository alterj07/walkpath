import { describe, expect, it } from 'vitest';
import { internshipGate } from '../../src/gates/internship.ts';

describe('internshipGate', () => {
  it('accepts intern words in the title with word boundaries', () => {
    expect(internshipGate({ title: 'Software Engineer Intern' }).verdict).toBe('intern');
    expect(internshipGate({ title: 'Summer 2027 Interns - Engineering' }).verdict).toBe('intern');
    expect(internshipGate({ title: 'Internship: Machine Learning' }).verdict).toBe('intern');
    expect(internshipGate({ title: 'Co-op Firmware' })).toMatchObject({ verdict: 'intern', employment_type: 'co_op' });
    expect(internshipGate({ title: 'Software Developer Coop' }).employment_type).toBe('co_op');
  });
  it('does not match internal, international or internet', () => {
    expect(internshipGate({ title: 'Internal Audit Analyst' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'International Tax Associate' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Internet Infrastructure Engineer' }).verdict).toBe('not_intern');
  });
  it('accepts the ATS employment type', () => {
    expect(internshipGate({ title: 'Software Developer', employmentType: 'Intern' }).verdict).toBe('intern');
    expect(internshipGate({ title: 'Software Developer', employmentType: 'Internship' }).verdict).toBe('intern');
    expect(internshipGate({ title: 'Software Developer', employmentType: 'Co-Op' })).toMatchObject({
      verdict: 'intern',
      employment_type: 'co_op',
    });
    expect(internshipGate({ title: 'Software Developer', employmentType: 'FullTime' }).verdict).toBe('not_intern');
  });
  it('drops senior titles and roles about interns even when they contain intern words', () => {
    expect(internshipGate({ title: 'Senior Intern Coordinator' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Intern Coordinator' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Internship Program Manager' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Senior Software Engineer' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Sr. Data Scientist' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Staff Engineer', employmentType: 'Intern' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Director of Engineering' }).verdict).toBe('not_intern');
  });
  it('keeps role titles that merely contain "manager"', () => {
    expect(internshipGate({ title: 'Product Manager Intern' }).verdict).toBe('intern');
    expect(internshipGate({ title: 'Technical Program Manager Intern' }).verdict).toBe('intern');
    expect(internshipGate({ title: 'Engineering Manager' }).verdict).toBe('not_intern');
  });
  it('drops experience requirements of 3+ years in the title', () => {
    expect(internshipGate({ title: 'Software Engineer, 5+ years experience' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Backend Engineer (3 years)' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Intern - 2 years program' }).verdict).toBe('intern');
  });
  it('marks ambiguous early-career titles for the LLM', () => {
    for (const t of [
      'Summer Analyst',
      'University Program - Software Engineering',
      'Student Software Developer',
      'Student Engineer',
      'Apprentice Software Engineer',
      'Baseball Technology Fellow',
      'Software Engineer, New Grad',
    ]) {
      expect(internshipGate({ title: t }).verdict, t).toBe('ambiguous');
    }
  });
  it('rejects everything else', () => {
    expect(internshipGate({ title: 'Software Engineer' }).verdict).toBe('not_intern');
    expect(internshipGate({ title: 'Full Stack Developer' }).verdict).toBe('not_intern');
  });
});

describe('internshipGate masked phrases', () => {
  it('treats "Chief of Staff Intern" as an internship', () => {
    expect(internshipGate({ title: 'Chief of Staff Intern' }).verdict).toBe('intern');
    expect(internshipGate({ title: 'Chief of Staff' }).verdict).toBe('not_intern');
  });
});
