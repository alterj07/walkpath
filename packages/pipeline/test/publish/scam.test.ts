import { describe, expect, it } from 'vitest';
import { scamSignals } from '../../src/publish/scam.ts';

function run(descriptionText: string, title = 'Software Engineering Intern', companyKnown = true) {
  return scamSignals({ title, descriptionText, companyKnown });
}

describe('scamSignals positives', () => {
  const positives: Array<[string, string]> = [
    ['fee_request', 'Candidates must pay a $50 registration fee before onboarding.'],
    ['fee_request', 'A training fee of $199 is required to receive your materials.'],
    ['fee_request', 'A refundable deposit of $100 is required for the laptop.'],
    ['wire_transfer', 'We will send your first paycheck by wire transfer after you send a payment to activate.'],
    ['wire_transfer', 'Payment via Western Union to our HR agent.'],
    ['gift_card', 'Please purchase Apple gift cards and send the codes to your manager.'],
    ['crypto_payment', 'Interns are paid in bitcoin weekly.'],
    ['crypto_payment', 'You will send USDT to the onboarding wallet.'],
    ['chat_app_to_apply', 'To apply, contact our recruiter on WhatsApp at +1 555 010 2000.'],
    ['chat_app_to_apply', 'Message us on Telegram to apply.'],
    ['ssn_request', 'Send your SSN and a photo of your ID to complete the application.'],
    ['ssn_request', 'Provide your bank account details before the interview.'],
    ['earn_from_home', 'Earn $500 per day from home, no experience needed!'],
    ['earn_from_home', 'Work from home and make up to $2,000 a week.'],
    ['pay_for_equipment', 'You will purchase your own equipment upfront and be reimbursed later.'],
    ['check_cashing', 'Deposit the check we send and forward the remainder to our vendor.'],
  ];
  for (const [signal, text] of positives) {
    it(`flags ${signal}: "${text.slice(0, 40)}"`, () => {
      const r = run(text);
      expect(r.held).toBe(true);
      expect(r.signals).toContain(signal);
    });
  }

  it('flags an unknown company', () => {
    const r = run('A normal posting.', 'Data Intern', false);
    expect(r.held).toBe(true);
    expect(r.signals).toEqual(['unknown_company']);
  });

  it('reads the title too', () => {
    expect(run('Nothing here.', 'Earn $300 per day from home - Data Entry Intern').held).toBe(true);
  });
});

describe('scamSignals negatives', () => {
  const negatives = [
    'You will work on cryptography primitives and post-quantum key exchange.',
    'Design and test the wire harness for the flight computer.',
    'We offer a fee waiver for the certification exam.',
    'We are an equal opportunity employer and consider applicants without regard to race, religion, or national origin. Social Security number is collected only after an offer for I-9 purposes.',
    'Telegram is a messaging company; this role is on the Android team.',
    'Interns receive a laptop and all equipment at no cost.',
    'Compensation: $45 per hour. Hybrid, 3 days in office.',
    'Our team builds payment rails for bitcoin exchanges and crypto custodians.',
    'Apply through our careers page; a recruiter will contact you by email.',
    'A background check is conducted at no cost to the candidate.',
    'Gift card program: interns receive a $100 gift card at the end of the summer.',
    'Relocation stipend of $2,000 and housing assistance provided.',
    'Earn course credit while working from our Austin office.',
    'You may be asked to provide a copy of your transcript.',
    'You will build payment rails: ACH, wire transfer, RTP and card networks.',
    'Train wire transfer fraud models on historical transaction data.',
    'SSN required for payroll after your offer; you will provide your social security number to HR.',
    'New hires enter their social security number on the I-9 form for employment eligibility.',
    'We will never ask you to pay a registration fee or any other fee during hiring.',
    "Rocket Lab does not charge an application fee; don't pay anyone claiming to be us.",
  ];
  for (const text of negatives) {
    it(`does not flag "${text.slice(0, 40)}"`, () => {
      const r = run(text);
      expect(r.signals).toEqual([]);
      expect(r.held).toBe(false);
    });
  }
});
