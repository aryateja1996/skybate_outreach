export const DEFAULT_TEMPLATE_NAME = 'Vendor empanelment request';

export const DEFAULT_SUBJECT =
  'Vendor Empanelment Request | IT Staffing Services | Skybate Technologies';

export const DEFAULT_BODY = `Hi {{contact_name}},

I hope you are doing well.

I'm Sreekar from Skybate Technologies Pvt. Ltd., a Hyderabad-based IT staffing and recruitment services company.

We would like to explore an opportunity to partner with {{company_name}} as a staffing vendor and support your technology hiring requirements.

Our recruitment focus includes AI/ML, Data Engineering, Software Development, Cloud, DevOps, Mobile Application Development, and other technology roles.

Could you please guide us through your vendor registration or empanelment process?

We would be happy to share our company profile and the documentation required for registration.

Looking forward to exploring a potential partnership.

Best regards,
Sreekar Kondaveeti
Director
Skybate Technologies Pvt. Ltd.
https://skybate.in`;

export const TEMPLATE_STYLES = ['professional', 'concise', 'formal'] as const;
export type TemplateStyle = (typeof TEMPLATE_STYLES)[number];

export const ALLOWED_PLACEHOLDERS = [
  'contact_name',
  'company_name',
  'designation',
  'website',
  'email',
] as const;
