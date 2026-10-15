import { describe, expect, it } from 'vitest';
import { extractCitizenship, extractDegreeLevel, extractGradYear, extractMajors, extractSkills, parseResume } from '../src/lib/resume.ts';

const NOW = new Date('2026-10-10T00:00:00Z');

const RESUME_A = `Jane Doe
jane@example.edu · San Francisco, CA
EDUCATION
University of California, Berkeley — B.S. in Computer Science, Expected May 2028. GPA 3.8
SKILLS
Languages: Python, C++, TypeScript, SQL
Frameworks: React, Node.js, PyTorch
Tools: Git, Docker, AWS, Linux
EXPERIENCE
Software Engineering Intern, Acme Robotics — built ROS nodes in C++ and trained models with PyTorch.
Authorized to work in the United States; U.S. citizen.`;

const RESUME_B = `John Smith
Education
Georgia Institute of Technology, Atlanta, GA
Master of Science in Electrical and Computer Engineering     Aug 2025 - May 2027
Bachelor of Science in Electrical Engineering, Class of 2025
Technical skills: Verilog, FPGA design (Xilinx), MATLAB, Simulink, embedded C, STM32, Altium
Projects: implemented a UART controller on an FPGA; wrote firmware for an STM32 flight computer.
Visa status: F-1 student, will require sponsorship.`;

const RESUME_C = `Alex Lee
Objective: entry-level data role
University of Texas at Austin · Bachelor of Arts in Mathematics and Data Science · 2024 – 2029
Coursework: Statistics, Linear Algebra, Machine Learning
Skills: R, pandas, scikit-learn, Tableau, Excel, Java
Experience: Data analyst intern at a startup; built dashboards in Tableau and models with scikit-learn.`;

describe('resume parsing', () => {
  it('reads an "Expected May 2028" bachelor resume', () => {
    const p = parseResume(RESUME_A, NOW);
    expect(p.grad_year).toBe(2028);
    expect(p.degree_level).toBe('bachelors');
    expect(p.majors).toEqual(['Computer Science']);
    expect(p.skills).toEqual(expect.arrayContaining(['Python', 'C++', 'TypeScript', 'SQL', 'React', 'Node', 'PyTorch', 'Git', 'Docker', 'AWS', 'Linux', 'ROS']));
    expect(p.skills).not.toContain('Rust');
    expect(p.citizen).toBe(true);
    expect(p.needs_sponsorship).toBe(false);
    expect(p.enrolled).toBe(true);
  });

  it('reads a master resume with a date range and an F-1 note', () => {
    const p = parseResume(RESUME_B, NOW);
    expect(p.grad_year).toBe(2027);
    expect(p.degree_level).toBe('masters');
    expect(p.majors).toEqual(expect.arrayContaining(['Electrical Engineering']));
    expect(p.skills).toEqual(expect.arrayContaining(['Verilog', 'FPGA', 'MATLAB', 'Simulink', 'Microcontrollers', 'PCB Design', 'Firmware']));
    expect(p.citizen).toBe(false);
    expect(p.needs_sponsorship).toBe(true);
  });

  it('reads a bachelor of arts with a long date range and no citizenship clue', () => {
    const p = parseResume(RESUME_C, NOW);
    expect(p.grad_year).toBe(2029);
    expect(p.degree_level).toBe('bachelors');
    expect(p.majors).toEqual(expect.arrayContaining(['Mathematics', 'Data Science']));
    expect(p.skills).toEqual(expect.arrayContaining(['R', 'pandas', 'scikit-learn', 'Tableau', 'Excel', 'Java', 'Machine Learning', 'Statistics', 'Linear Algebra']));
    expect(p.citizen).toBeUndefined();
    expect(p.needs_sponsorship).toBeUndefined();
  });

  it('matches skills on word boundaries only', () => {
    expect(extractSkills('I like javascripting and going places')).not.toContain('Go');
    expect(extractSkills('I like javascripting and going places')).not.toContain('JavaScript');
    expect(extractSkills('Go, Rust and C')).toEqual(expect.arrayContaining(['Go', 'Rust', 'C']));
    expect(extractSkills('C# and C++')).toEqual(expect.arrayContaining(['C#', 'C++']));
    expect(extractSkills('Scarlet letter')).not.toContain('R');
  });

  it('ignores graduation years far outside the plausible window', () => {
    expect(extractGradYear('Class of 2010', NOW)).toBeNull();
    expect(extractGradYear("Class of '29", NOW)).toBe(2029);
    expect(extractGradYear('nothing here', NOW)).toBeNull();
  });

  it('degree level, majors and citizenship are null/empty when unstated', () => {
    expect(extractDegreeLevel('Skills: Python')).toBeNull();
    expect(extractMajors('Skills: Python')).toEqual([]);
    expect(extractCitizenship('Skills: Python')).toEqual({ citizen: null, needs_sponsorship: null });
  });
});
