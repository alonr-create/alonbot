/**
 * Content sanitization utility — filters prompt injection patterns
 * from web content returned by browse_url and scrape_site.
 */

const INJECTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // "Ignore previous instructions" variants
  { pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directives)/gi, replacement: '[filtered]' },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/gi, replacement: '[filtered]' },
  { pattern: /forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/gi, replacement: '[filtered]' },
  { pattern: /override\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/gi, replacement: '[filtered]' },

  // "You are now" / role reassignment
  { pattern: /you\s+are\s+now\s+(a|an|the)\s+/gi, replacement: '[filtered] ' },
  { pattern: /your\s+new\s+(role|instructions|task)\s+(is|are)/gi, replacement: '[filtered]' },

  // Fake tool-use XML tags
  { pattern: /<\/?tool_use>/gi, replacement: '[filtered-tag]' },
  { pattern: /<\/?function_call>/gi, replacement: '[filtered-tag]' },
  { pattern: /<\/?tool_result>/gi, replacement: '[filtered-tag]' },
  { pattern: /<\/?tool_name>/gi, replacement: '[filtered-tag]' },
  { pattern: /<\/?invoke>/gi, replacement: '[filtered-tag]' },

  // Zero-width character sequences (hidden text)
  { pattern: /[\u200B\u200C\u200D\uFEFF\u2060\u200E\u200F]{2,}/g, replacement: '' },

  // Base64/eval code injection
  { pattern: /eval\s*\(\s*atob\s*\(/gi, replacement: '[filtered]' },
  { pattern: /eval\s*\(\s*Buffer\.from\s*\(/gi, replacement: '[filtered]' },
  { pattern: /new\s+Function\s*\(/gi, replacement: '[filtered]' },

  // Shell code blocks targeting destructive commands
  { pattern: /```(?:bash|sh|shell)\s*\n\s*(?:rm\s+-rf|curl.*\|\s*(?:ba)?sh|wget.*\|\s*(?:ba)?sh)/gi, replacement: '```\n[filtered-dangerous-command]' },

  // HTML comments (can contain hidden instructions)
  { pattern: /<!--[\s\S]*?-->/g, replacement: '' },

  // System prompt extraction attempts
  { pattern: /(?:show|print|display|output|reveal|repeat)\s+(?:your\s+)?system\s+prompt/gi, replacement: '[filtered]' },
  { pattern: /what\s+(?:is|are)\s+your\s+(?:system\s+)?instructions/gi, replacement: '[filtered]' },
];

export function sanitizeWebContent(content: string): string {
  let result = content;
  for (const { pattern, replacement } of INJECTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
