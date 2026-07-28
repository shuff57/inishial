// What a SECTION is. One definition, because three different things depend on
// agreeing about it:
//
//   - the editor, where dragging a heading carries its whole section
//   - functions/_lib/syllabus.js, where a signature hashes a section's text
//   - the signing page, where a section is one sheet of the notebook
//
// If these ever disagree, a parent initials a span of text different from the
// one they were shown. That is the bug this file exists to prevent.

/** [from, to) for each section: a heading and everything under it. Blocks before
 *  the first heading form a leading section with no heading of its own. */
export function sectionRanges(blocks) {
  const out = [];
  let start = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === 'heading' && i > start) { out.push([start, i]); start = i; }
  }
  if (blocks.length) out.push([start, blocks.length]);
  return out;
}

/** The same split, handed back as arrays of blocks rather than index pairs --
 *  which is what a renderer wants and an index-mover does not. */
export function sections(blocks) {
  return sectionRanges(blocks).map(([from, to]) => blocks.slice(from, to));
}

/** The visible title of a section, or null for a run of blocks that opens the
 *  document without a heading of its own. */
export function sectionTitle(section) {
  const head = section[0];
  if (!head || head.type !== 'heading') return null;
  return String(head.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null;
}
