const OUTPUT_LIMIT = 256 * 1024;
const REDACTIONS = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[redacted credential]'],
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*)[^\s"']+/gi, '$1[redacted]'],
];

export function sanitizeOutput(input) {
  let value = String(input ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const [pattern, replacement] of REDACTIONS) value = value.replace(pattern, replacement);
  return value.slice(0, OUTPUT_LIMIT);
}
