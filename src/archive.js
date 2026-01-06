import fs from 'fs';
import path from 'path';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureTrailingNewline(s) {
  if (s === '') return s;
  return s.endsWith('\n') ? s : s + '\n';
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map(t => String(t).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
}

function wrapAsBlockquote(text, maxLines = 3) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(0, maxLines);
  return lines.map(l => `> ${l}`).join('\n');
}

export function formatArchiveEntry(entry, filedPaths = []) {
  const author = entry.author_username ? `@${entry.author_username}` : '@unknown';
  const title = entry.title ? String(entry.title).trim() : 'Untitled';
  const tweetUrl = String(entry.tweet_url || '').trim();
  const expandedLinks = Array.isArray(entry.expanded_links) ? entry.expanded_links.filter(Boolean) : [];
  const tags = normalizeTags(entry.tags);

  const quoted = wrapAsBlockquote(entry.excerpt, 3);
  const lines = [];
  lines.push(`## ${author} — ${title}`);
  lines.push('');
  if (quoted) {
    lines.push(quoted);
    lines.push('');
  }
  lines.push(`- Tweet URL: ${tweetUrl}`);
  if (expandedLinks.length) {
    lines.push(`- Expanded link(s): ${expandedLinks.join(', ')}`);
  }
  if (tags.length) {
    lines.push(`- Tags: ${tags.join(', ')}`);
  }
  if (filedPaths.length) {
    lines.push(`- Filed: ${filedPaths.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function findHeaderIndex(text, headerLine) {
  const re = new RegExp(`(^|\\n)${escapeRegExp(headerLine)}\\n`);
  const match = re.exec(text);
  if (!match) return null;
  return match.index + (match[1] ? match[1].length : 0);
}

export function applyArchiveUpdates(existingText, groupedAdditions) {
  let text = existingText || '';

  // Newest-first insertion: process in the given order (caller should sort).
  for (const group of groupedAdditions) {
    const headerLine = `# ${group.date}`;
    const body = ensureTrailingNewline(group.body);
    if (!body.trim()) continue;

    const headerIdx = findHeaderIndex(text, headerLine);
    if (headerIdx === null) {
      const prefix = `${headerLine}\n\n${body}\n`;
      text = prefix + ensureTrailingNewline(text);
      continue;
    }

    // Insert right after header line + optional blank line.
    const afterHeaderIdx = headerIdx + headerLine.length + 1; // + newline
    let insertAt = afterHeaderIdx;
    if (text.slice(insertAt, insertAt + 1) === '\n') {
      insertAt += 1;
    }
    text = text.slice(0, insertAt) + body + text.slice(insertAt);
  }

  return text;
}

export function loadTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export function writeTextAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

