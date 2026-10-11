/** Only literal module references become edges; computed imports are disclosed. */
export function inspectImports(source: string): { specifiers: string[]; unsupported: boolean } {
  const tokens: Array<{ value: string; literal: boolean }> = [];
  let unsupported = false;
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) unsupported = true; i = end < 0 ? source.length : end + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = ++i;
      let interpolated = false;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { i += 2; continue; }
        if (quote === '`' && source.startsWith('${', i)) interpolated = true;
        i++;
      }
      if (i >= source.length) unsupported = true;
      tokens.push({ value: source.slice(start, i), literal: !interpolated });
      i++;
      continue;
    }
    // Skip regex text in expression-start positions; division is punctuation.
    if (ch === '/' && (!tokens.length || ['=', '(', '[', ',', ':', 'return', '!'].includes(tokens[tokens.length - 1].value))) {
      i++;
      let characterClass = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') characterClass = true;
        if (source[i] === ']') characterClass = false;
        if (source[i++] === '/' && !characterClass) break;
      }
      while (i < source.length && /[a-z]/i.test(source[i])) i++;
      tokens.push({ value: '<regex>', literal: false });
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
    tokens.push({ value: word?.[0] ?? ch, literal: false });
    i += word?.[0].length ?? 1;
  }
  const specifiers: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.literal || tokens[i - 1]?.value === '.') continue;
    if (token.value === 'require' || token.value === 'import' && tokens[i + 1]?.value === '(') {
      if (tokens[i + 1]?.value !== '(') continue;
      const argument = tokens[i + 2];
      if (argument?.literal && [')', ','].includes(tokens[i + 3]?.value)) specifiers.push(argument.value);
      else unsupported = true;
      continue;
    }
    if (token.value !== 'import' && token.value !== 'export') continue;
    if (token.value === 'import' && tokens[i + 1]?.literal) { specifiers.push(tokens[i + 1].value); continue; }
    if (token.value === 'import' && tokens[i + 1]?.value === '.') continue;
    if (token.value === 'export' && !['{', '*', 'type'].includes(tokens[i + 1]?.value)) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      if ([';', 'import', 'export', 'const', 'function'].includes(tokens[j].value) && !tokens[j].literal) break;
      if (tokens[j].value === 'from' && tokens[j + 1]?.literal) { specifiers.push(tokens[j + 1].value); break; }
    }
  }
  return { specifiers: [...new Set(specifiers)], unsupported };
}
