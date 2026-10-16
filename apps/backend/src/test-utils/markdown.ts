import { Parser } from 'commonmark';

/** Inspect actual CommonMark structure, rather than testing fence substrings. */
export function markdownNodes(body: string): { type: string; literal: string | null; info: string | null }[] {
  const walker = new Parser().parse(body).walker();
  const nodes = [];
  let event;
  while ((event = walker.next())) {
    if (event.entering) nodes.push({ type: event.node.type, literal: event.node.literal, info: event.node.info });
  }
  return nodes;
}
