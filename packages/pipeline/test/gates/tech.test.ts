import { describe, expect, it } from 'vitest';
import { techGate } from '../../src/gates/tech.ts';

const families: Array<[string, string]> = [
  ['Software Engineer Intern', 'software_engineering'],
  ['SWE Intern', 'software_engineering'],
  ['Full Stack Developer Intern', 'software_engineering'],
  ['iOS Developer Intern', 'software_engineering'],
  ['QA Engineer Intern', 'software_engineering'],
  ['Engineering Intern', 'software_engineering'],
  ['Intern - Engineering', 'software_engineering'],
  ['Financial Software Engineer Intern', 'software_engineering'],
  ['Software Engineer Intern - Network Security', 'software_engineering'],
  ['Machine Learning Engineer Intern', 'data_ml_ai'],
  ['Data Science Intern', 'data_ml_ai'],
  ['Data Analyst Intern', 'data_ml_ai'],
  ['Research Scientist Intern - NLP', 'data_ml_ai'],
  ['Marketing Data Scientist Intern', 'data_ml_ai'],
  ['Analytics Intern', 'data_ml_ai'],
  ['AI Software Engineer Intern', 'data_ml_ai'],
  ['IT Intern', 'it_cloud_security'],
  ['Information Technology Intern', 'it_cloud_security'],
  ['Cloud Engineering Intern', 'it_cloud_security'],
  ['Cybersecurity Intern', 'it_cloud_security'],
  ['DevOps Intern', 'it_cloud_security'],
  ['Network Engineering Intern', 'it_cloud_security'],
  ['Help Desk Intern', 'it_cloud_security'],
  ['Product Manager Intern', 'product'],
  ['APM Intern', 'product'],
  ['Technical Program Manager Intern', 'product'],
  ['Product Manager Intern - HR Technology', 'product'],
  ['Product Design Intern', 'ux_design'],
  ['UX Research Intern', 'ux_design'],
  ['UI/UX Intern', 'ux_design'],
  ['Firmware Engineer Intern', 'hardware_embedded'],
  ['Embedded Software Engineer Intern', 'hardware_embedded'],
  ['Hardware Engineering Intern', 'hardware_embedded'],
  ['Electrical Engineering Intern', 'hardware_embedded'],
  ['FPGA Intern', 'hardware_embedded'],
  ['ASIC Design Intern', 'hardware_embedded'],
  ['RF Engineering Intern', 'hardware_embedded'],
  ['Flight Software Intern Summer 2027', 'hardware_embedded'],
  ['Design Verification Intern', 'hardware_embedded'],
  ['Quantitative Researcher Intern', 'quant_research'],
  ['Quant Trading Intern', 'quant_research'],
  ['Algorithmic Trading Developer Co-op', 'quant_research'],
  ['Sports Quantitative Analyst Intern', 'quant_research'],
];

const notTech = [
  'Marketing Intern',
  'Sales Engineer Intern',
  'Finance Intern',
  'HR Intern',
  'Mechanical Engineer Intern',
  'Civil Engineering Intern',
  'Chemical Engineering Co-op',
  'Nursing Intern',
  'Graphic Design Intern',
  'Supply Chain Intern',
  'Investment Banking Summer Analyst',
  'Commodities Trading Intern',
  'Teaching Intern',
  'Senior Intern Coordinator',
];

describe('techGate', () => {
  for (const [title, family] of families) {
    it(`assigns ${family} to ${JSON.stringify(title)}`, () => {
      expect(techGate(title)).toMatchObject({ verdict: 'tech', family });
    });
  }
  for (const title of notTech) {
    it(`rejects ${JSON.stringify(title)}`, () => {
      expect(techGate(title).verdict).toBe('not_tech');
    });
  }
  it('sends titles with no keyword but a technical department to the LLM', () => {
    expect(techGate('Summer Intern', 'Engineering').verdict).toBe('ambiguous');
    expect(techGate('Summer Analyst').verdict).toBe('ambiguous');
    expect(techGate('Intern 8').verdict).toBe('not_tech');
    expect(techGate('Baseball Technology Fellow').verdict).toBe('ambiguous');
  });
  it('reports what matched', () => {
    expect(techGate('Firmware Engineer Intern').matched.toLowerCase()).toContain('firmware');
    expect(techGate('Marketing Intern').matched.toLowerCase()).toContain('marketing');
  });
});

describe('techGate soft non-tech words', () => {
  it.each([
    ['Video Codec Engineer Intern', ['ambiguous', 'tech']],
    ['Trust & Safety Engineer Intern', ['ambiguous']],
    ['Physics Simulation Engineer Intern', ['ambiguous', 'tech']],
    ['Sales Engineer Intern', ['not_tech']],
    ['Mechanical Engineering Intern', ['not_tech']],
    ['Marketing Intern', ['not_tech']],
    ['Content Intern', ['not_tech']],
    ['Economics Research Intern', ['not_tech']],
  ])('%s → %s', (title, verdicts) => {
    expect(verdicts).toContain(techGate(title).verdict);
  });
});
