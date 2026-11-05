export type FencePart = { kind: 'text'; text: string } | {
  kind: 'code'; info: string; code: string; raw: string; closed: boolean;
};

/** Scan top-level fences without interpreting fenced examples as Markdown. */
export function splitFences(text: string): FencePart[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const parts: FencePart[] = [];
  let prose: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) { prose.push(lines[i]); continue; }
    if (prose.length) { parts.push({ kind: 'text', text: prose.join('\n') }); prose = []; }
    const start = i;
    const body: string[] = [];
    const close = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}\\s*$`);
    for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
    const closed = i < lines.length;
    parts.push({ kind: 'code', info: open[2].trim(), code: body.join('\n'), raw: lines.slice(start, i + 1).join('\n'), closed });
  }
  if (prose.length) parts.push({ kind: 'text', text: prose.join('\n') });
  return parts;
}
