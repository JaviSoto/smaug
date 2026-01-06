import { test, describe } from 'node:test';
import assert from 'node:assert';
import { applyArchiveUpdates, formatArchiveEntry } from '../src/archive.js';

describe('archive formatting + insertion', () => {
  test('formats an entry with tweet URL and tags', () => {
    const md = formatArchiveEntry({
      tweet_url: 'https://x.com/a/status/1',
      author_username: 'alice',
      title: 'Hello world',
      excerpt: 'hi there',
      tags: ['Test', 'foo'],
      expanded_links: ['https://example.com'],
    });
    assert.ok(md.includes('## @alice — Hello world'));
    assert.ok(md.includes('- Tweet URL: https://x.com/a/status/1'));
    assert.ok(md.includes('- Expanded link(s): https://example.com'));
    assert.ok(md.includes('- Tags: test, foo'));
  });

  test('prepends a new date header when missing', () => {
    const existing = '# Monday, January 6, 2026\n\n## @x — Existing\n\n- Tweet URL: https://x.com/x/status/0\n\n';
    const updated = applyArchiveUpdates(existing, [
      { date: 'Tuesday, January 7, 2026', body: '## @a — New\n\n- Tweet URL: https://x.com/a/status/1\n\n' },
    ]);
    assert.ok(updated.startsWith('# Tuesday, January 7, 2026'));
    assert.ok(updated.includes('# Monday, January 6, 2026'));
  });

  test('inserts under existing date header when present', () => {
    const existing = [
      '# Tuesday, January 7, 2026',
      '',
      '## @x — Existing',
      '',
      '- Tweet URL: https://x.com/x/status/0',
      '',
      '# Monday, January 6, 2026',
      '',
      '## @y — Older',
      '',
      '- Tweet URL: https://x.com/y/status/9',
      '',
    ].join('\n');

    const updated = applyArchiveUpdates(existing, [
      { date: 'Tuesday, January 7, 2026', body: '## @a — New\n\n- Tweet URL: https://x.com/a/status/1\n\n' },
    ]);

    const idxHeader = updated.indexOf('# Tuesday, January 7, 2026');
    const idxNew = updated.indexOf('## @a — New');
    const idxExisting = updated.indexOf('## @x — Existing');
    assert.ok(idxHeader !== -1);
    assert.ok(idxNew > idxHeader);
    assert.ok(idxExisting > idxNew);
  });
});

