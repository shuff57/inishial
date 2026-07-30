// The heading-repair pass. The model is allowed to say WHAT a line is; it is
// never allowed to say what a line SAYS. Every test here is about that line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, ADMIN_HEADERS, jsonRequest } from './helpers.mjs';
import { onRequestPost as structure } from '../functions/api/admin/structure.js';
import { retag, blockText, sectionRanges, looksUnstructured, structureProblem, structureAdvice, textToBlocks } from '../public/admin/editor/reorder.js';

// A syllabus written the way many teachers write one: headings are bold
// paragraphs, not Word heading styles. Mammoth emits them as <p><strong>.
const BOLD_HEADINGS = [
  { type: 'text', html: '<p><strong>Late Work</strong></p>' },
  { type: 'text', html: '<p>Assignments lose 10% per school day.</p>' },
  { type: 'text', html: '<p><strong>Instructor: Jane Okafor</strong></p>' },
  { type: 'initial', html: 'I have read the late work policy.' },
  { type: 'list', html: '<ul><li>A pencil</li></ul>' },
];

// ---- applying a retag never touches the words ----

test('promoting a bold line to a heading keeps its words exactly', () => {
  const out = retag(BOLD_HEADINGS, [{ index: 0, tag: 'heading' }]);
  assert.equal(out[0].type, 'heading');
  assert.equal(out[0].html, '<h2>Late Work</h2>');
  assert.equal(blockText(out[0].html), blockText(BOLD_HEADINGS[0].html));
});

test('no retag can change a single word anywhere in the document', () => {
  const changes = BOLD_HEADINGS.map((_, i) => ({ index: i, tag: 'heading' }))
    .concat(BOLD_HEADINGS.map((_, i) => ({ index: i, tag: 'text' })));
  const out = retag(BOLD_HEADINGS, changes);
  assert.deepEqual(out.map((b) => blockText(b.html)), BOLD_HEADINGS.map((b) => blockText(b.html)));
});

test('a prompt is never retagged, even when asked', () => {
  const out = retag(BOLD_HEADINGS, [{ index: 3, tag: 'heading' }]);
  assert.equal(out[3].type, 'initial',
    'retagging a prompt would drop a signature obligation out of the document');
});

test('a list is never retagged, even when asked', () => {
  const out = retag(BOLD_HEADINGS, [{ index: 4, tag: 'heading' }]);
  assert.equal(out[4].type, 'list');
  assert.equal(out[4].html, '<ul><li>A pencil</li></ul>');
});

test('a bogus tag is ignored rather than applied', () => {
  const out = retag(BOLD_HEADINGS, [{ index: 0, tag: 'agree' }, { index: 1, tag: 'script' }]);
  assert.equal(out[0].type, 'text');
  assert.equal(out[1].type, 'text');
});

test('retagging is what turns one blob into real sections', () => {
  assert.equal(sectionRanges(BOLD_HEADINGS).length, 1, 'no headings means one giant section');
  const out = retag(BOLD_HEADINGS, [{ index: 0, tag: 'heading' }]);
  assert.equal(sectionRanges(out).length, 1, 'a heading at index 0 still opens a single section');

  const two = retag(
    [{ type: 'text', html: '<p>intro</p>' }, ...BOLD_HEADINGS],
    [{ index: 1, tag: 'heading' }],
  );
  assert.equal(sectionRanges(two).length, 2, 'preamble, then the Late Work section');
});

test('an empty block is left alone rather than becoming an empty heading', () => {
  const out = retag([{ type: 'text', html: '<p><strong> </strong></p>' }], [{ index: 0, tag: 'heading' }]);
  assert.equal(out[0].type, 'text');
});

// ---- the endpoint hands back tags, never text ----

const post = (env, blocks) =>
  structure({ request: jsonRequest('https://x/api/admin/structure', { blocks }, ADMIN_HEADERS), env });

test('the endpoint refuses a request without admin', async () => {
  const env = freshEnv();
  const res = await structure({ request: jsonRequest('https://x/api/admin/structure', { blocks: [] }), env });
  assert.equal(res.status, 401);
});

test('with no key it fails soft, so the editor still works', async () => {
  const env = freshEnv();
  const body = await (await post(env, BOLD_HEADINGS)).json();
  assert.equal(body.available, false);
  assert.deepEqual(body.retag, []);
  assert.match(body.reason, /OLLAMA_API_KEY/);
});

test('a model that tries to return text has nowhere to put it', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test', OLLAMA_HOST: 'https://ollama.invalid' });
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({ retag: [
      { index: 0, tag: 'heading', html: '<h2>REWRITTEN BY THE MODEL</h2>' },
      { index: 1, tag: 'heading', text: 'Assignments lose 50% per day.' },
    ] }) },
  }), { status: 200 });

  const body = await (await post(env, BOLD_HEADINGS)).json();
  assert.deepEqual(body.retag, [{ index: 0, tag: 'heading' }, { index: 1, tag: 'heading' }],
    'only index and tag survive; html and text are dropped');
  assert.ok(!JSON.stringify(body).includes('REWRITTEN'), 'no model-authored text may reach the client');
  assert.ok(!JSON.stringify(body).includes('50%'));
});

test('hallucinated and no-op indices are dropped', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({ retag: [
      { index: 99, tag: 'heading' },      // never sent
      { index: 3, tag: 'heading' },       // a prompt: not a candidate
      { index: 1, tag: 'text' },          // already text: no change
      { index: 0, tag: 'heading' },       // the only real one
      { index: 0, tag: 'text' },          // duplicate index
    ] }) },
  }), { status: 200 });

  const body = await (await post(env, BOLD_HEADINGS)).json();
  assert.deepEqual(body.retag, [{ index: 0, tag: 'heading' }]);
});

test('an unreachable model fails soft rather than erroring', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const body = await (await post(env, BOLD_HEADINGS)).json();
  assert.equal(body.available, false);
  assert.deepEqual(body.retag, []);
});

test('garbage back from the model fails soft', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  globalThis.fetch = async () => new Response('not json at all', { status: 200 });
  const body = await (await post(env, BOLD_HEADINGS)).json();
  assert.equal(body.available, false);
});

// ---- when to OFFER the pass ----

const flat = (n) => Array.from({ length: n }, (_, i) => ({ type: 'text', html: `<p>line ${i}</p>` }));
const withHeadings = (n) => Array.from({ length: n }, (_, i) =>
  (i % 3 === 0 ? { type: 'heading', html: `<h2>H${i}</h2>` } : { type: 'text', html: `<p>line ${i}</p>` }));

test('a document with no headings at all is flagged', () => {
  assert.equal(looksUnstructured(flat(12)), true);
});

test('a properly sectioned document is not flagged', () => {
  assert.equal(looksUnstructured(withHeadings(12)), false);
});

test('a short document is never flagged, headings or not', () => {
  assert.equal(looksUnstructured(flat(5)), false, 'too little to judge, and the toolbar button still exists');
});

test('one heading swallowing the whole document is flagged', () => {
  const lopsided = [{ type: 'heading', html: '<h2>Syllabus</h2>' }, ...flat(19)];
  assert.equal(looksUnstructured(lopsided), true, 'one section of 20 is the same problem as none');
});

test('a real import of the actual syllabus shape is not flagged', () => {
  // 9 headings across 56 blocks, the shape Syllabus - Stats.docx produces.
  const real = [];
  for (let s = 0; s < 9; s++) {
    real.push({ type: 'heading', html: `<h2>Section ${s}</h2>` });
    for (let b = 0; b < 5; b++) real.push({ type: 'text', html: `<p>body ${s}.${b}</p>` });
  }
  assert.equal(looksUnstructured(real), false);
});

test('a paste that guessed too many headings is flagged', () => {
  // textToBlocks promotes any short unpunctuated line, so "Instructor: Steven
  // Huff" and "Email: ..." become headings alongside the real ones.
  const overGuessed = [
    { type: 'heading', html: '<h2>Instructor: Jane Okafor</h2>' },
    { type: 'heading', html: '<h2>Email: j.okafor@school.edu</h2>' },
    { type: 'heading', html: '<h2>Late Work</h2>' },
    { type: 'text', html: '<p>Assignments lose 10% per school day.</p>' },
    { type: 'heading', html: '<h2>Use of AI</h2>' },
    { type: 'text', html: '<p>Unattributed AI use is academic dishonesty.</p>' },
  ];
  assert.equal(looksUnstructured(overGuessed), true, '4 headings in 6 blocks is a mis-tag, not a structure');
});

test('demoting is a real outcome, not just promoting', () => {
  const out = retag(
    [{ type: 'heading', html: '<h2>Instructor: Jane Okafor</h2>' }, { type: 'text', html: '<p>body</p>' }],
    [{ index: 0, tag: 'text' }],
  );
  assert.equal(out[0].type, 'text');
  assert.equal(out[0].html, '<p>Instructor: Jane Okafor</p>');
  assert.equal(blockText(out[0].html), 'Instructor: Jane Okafor');
});

test('the notice names the problem it actually found', () => {
  assert.equal(structureProblem(flat(12)), 'none');
  assert.match(structureAdvice('none'), /no headings/);

  const over = Array.from({ length: 8 }, (_, i) =>
    (i < 5 ? { type: 'heading', html: `<h2>H${i}</h2>` } : { type: 'text', html: `<p>b${i}</p>` }));
  assert.equal(structureProblem(over), 'too-many');
  assert.match(structureAdvice('too-many'), /read as headings/);

  const lop = [{ type: 'heading', html: '<h2>Syllabus</h2>' }, ...flat(19)];
  assert.equal(structureProblem(lop), 'lopsided');
  assert.match(structureAdvice('lopsided'), /one heading/);

  assert.equal(structureProblem(withHeadings(12)), null);
});

test('every advice string promises the wording is untouched', () => {
  for (const p of ['none', 'too-many', 'lopsided']) {
    assert.match(structureAdvice(p), /wording is never changed/);
  }
});

// ---- a paste is split into lines, so the retag pass can tag them one by one ----

test('a heading and the body under it do not become one block', () => {
  // The exact shape that broke: no blank line between the heading and its
  // paragraph, so the old blank-line split handed the structure pass one block
  // that BEGAN with a heading -- and promoting it wrapped the whole policy in
  // an <h2>.
  const blocks = textToBlocks(
    'Butte College Course Information\n'
    + 'This course is offered for dual enrollment credit through Butte College.\n'
    + 'The grade earned becomes part of a permanent college transcript.',
  );

  assert.equal(blocks.length, 3, 'three lines, three blocks');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'text', 'text']);
  assert.equal(blocks[0].html, '<h2>Butte College Course Information</h2>');
  assert.ok(!blocks.some((b) => b.html.includes('<br>')), 'no block carries a second line');
});

test('only the first line of a chunk can be guessed into a heading', () => {
  // "Steven Huff" is short and unpunctuated, so the old per-chunk rule would
  // have taken it too. A heading introduces what follows; line four does not.
  const blocks = textToBlocks('Instructor\nSteven Huff\nEmail\nshuff@school.edu');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'text', 'text', 'text']);
});

test('a run of bullets stays one list, and the words survive escaping', () => {
  const blocks = textToBlocks('What to bring\n- A pencil\n- Paper & a folder\n\nGrading\nPoints are weighted.');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'list', 'heading', 'text']);
  assert.equal(blocks[1].html, '<ul><li>A pencil</li><li>Paper &amp; a folder</li></ul>');
});

test('every pasted word survives, in order', () => {
  const source = 'Late Work\nAssignments lose 10% per school day.\n\nUse of AI\n- Ask first\n- Cite it';
  const words = textToBlocks(source).map((b) => blockText(b.html)).join(' ');
  for (const w of ['Late', 'Work', 'Assignments', '10%', 'AI', 'Ask', 'first', 'Cite']) {
    assert.ok(words.includes(w), `"${w}" was dropped by the split`);
  }
});

// ---- a syllabus pasted as Markdown keeps its own structure ----

test('## and ### say what is a section and what is inside one', () => {
  const blocks = textToBlocks('## Grading Policy\nYour grade comes from four categories.\n### Late Work\nAssignments lose 10% per school day.');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'text', 'heading', 'text']);
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[2].level, 3, '### is a subheading, not a second section');
  assert.equal(blocks[2].html, '<h3>Late Work</h3>');
});

test('a Markdown table becomes a table, not four paragraphs', () => {
  const blocks = textToBlocks('| Category | Weight |\n|---|---|\n| Daily Homework | 15% |\n| Group Assessments | 10% |');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].html,
    '<table><thead><tr><th>Category</th><th>Weight</th></tr></thead>'
    + '<tbody><tr><td>Daily Homework</td><td>15%</td></tr><tr><td>Group Assessments</td><td>10%</td></tr></tbody></table>');
});

test('numbered course objectives keep their numbering', () => {
  const blocks = textToBlocks('1. Summarise data\n2. Interpret a confidence interval\n3. Run a t-test');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'list');
  assert.match(blocks[0].html, /^<ol>/);
  assert.equal(blocks[0].html.match(/<li>/g).length, 3);
});

test('a rule between sections is a separator, not a heading', () => {
  const blocks = textToBlocks('## Notes\n\n---\n\n## Use of AI');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'heading']);
});

test('bold and links survive, and markup in the source does not', () => {
  const blocks = textToBlocks('The **census date** is listed in the [portal](https://example.edu/portal).');
  assert.equal(blocks[0].html,
    '<p>The <strong>census date</strong> is listed in the <a href="https://example.edu/portal">portal</a>.</p>');

  const hostile = textToBlocks('Grades are final <script>alert(1)</script> after two weeks.');
  assert.ok(!hostile[0].html.includes('<script>'), 'a tag in the source stays words');
  assert.match(hostile[0].html, /&lt;script&gt;/);
});
