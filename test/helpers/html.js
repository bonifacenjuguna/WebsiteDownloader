// What Telegram accepts: balanced b/i/u/s/code/pre/blockquote/a tags, no stray < > &.
export function htmlProblems(s) {
  const problems = [];
  const stack = [];
  let rest = '';
  for (const part of String(s).split(/(<\/?[a-z]+(?:\s[^>]*)?>)/i)) {
    const m = /^<(\/?)([a-z]+)(?:\s[^>]*)?>$/i.exec(part);
    if (!m) { rest += part; continue; }
    const [, close, name] = m;
    if (!['b', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'a'].includes(name.toLowerCase())) problems.push(`tag <${name}> is not allowed`);
    if (!close) stack.push(name.toLowerCase());
    else if (stack.pop() !== name.toLowerCase()) problems.push(`unbalanced </${name}>`);
  }
  if (stack.length) problems.push(`unclosed <${stack.join('>, <')}>`);
  if (/[<>]/.test(rest)) problems.push('stray < or >');
  if (/&(?!(amp|lt|gt|quot|#\d+);)/.test(rest)) problems.push('stray &');
  return problems;
}
