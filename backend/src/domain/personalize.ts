export interface PersonalizationContact {
  contactName?: string | null;
  companyName?: string | null;
  designation?: string | null;
  website?: string | null;
  email?: string | null;
}

function clean(value?: string | null): string {
  return (value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

export function personalize(template: string, contact: PersonalizationContact): string {
  const name = clean(contact.contactName);
  const company = clean(contact.companyName) || 'your organization';
  const designation = clean(contact.designation);
  const website = clean(contact.website);
  const email = clean(contact.email);

  let text = template.replace(
    /\b(?:Hi|Hello|Dear)\s*\{\{\s*contact_name\s*\}\}\s*,?/gi,
    () => (name ? `Hi ${name},` : 'Hello,'),
  );

  const replacements: Record<string, string> = {
    contact_name: name,
    company_name: company,
    designation,
    website,
    email,
  };

  text = text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key: string) => {
    const normalized = key.toLowerCase();
    return normalized in replacements ? replacements[normalized] : '';
  });

  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function buildOutreachFooter(input: {
  unsubscribeUrl: string;
  senderEmail: string;
}): string {
  return [
    '',
    '---',
    'Skybate Technologies Pvt. Ltd. is contacting you about vendor empanelment for IT staffing services.',
    `Sender: ${input.senderEmail}`,
    'Website: https://skybate.in',
    `Unsubscribe from future outreach: ${input.unsubscribeUrl}`,
  ].join('\n');
}

export function footerPreview(publicApiUrl: string, senderEmail: string): string {
  return buildOutreachFooter({
    unsubscribeUrl: `${publicApiUrl.replace(/\/$/, '')}/unsubscribe/<unique-token>`,
    senderEmail,
  });
}
