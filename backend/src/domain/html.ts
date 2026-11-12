export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function textToHtml(body: string): string {
  const escaped = escapeHtml(body).replace(/\n/g, '<br>');
  return `<div style="font-family: Georgia, serif; font-size: 16px; line-height: 1.55; color: #1c1915;">${escaped}</div>`;
}
