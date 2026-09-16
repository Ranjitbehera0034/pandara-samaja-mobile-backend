// src/utils/privacy.ts
// Shared with the admin login flow's own masking (src/routes/admin.ts) —
// same format (dots + last 4 digits), kept here so the members directory
// can reuse it without duplicating the logic.
export function maskMobile(mobile: string | null | undefined): string {
  const digits = (mobile || '').replace(/\D/g, '');
  if (digits.length < 4) return '••••••';
  const lastFour = digits.slice(-4);
  return `${'•'.repeat(Math.max(digits.length - 4, 6))}${lastFour}`;
}

export function isFemaleGender(gender: string | null | undefined): boolean {
  return ['female', 'f'].includes((gender || '').toLowerCase().trim());
}
