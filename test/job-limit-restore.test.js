import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/job.js';

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('job --limit pending restore', () => {
  let tmpDir;
  let binDir;
  let originalPath;
  let originalOpenAIKey;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smaug-job-test-'));
    binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    originalPath = process.env.PATH || '';
    originalOpenAIKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('restores full pending when auto-invoke disabled', async () => {
    const pendingFile = path.join(tmpDir, '.state', 'pending-bookmarks.json');
    const configPath = path.join(tmpDir, 'smaug.config.json');

    writeJson(pendingFile, {
      generatedAt: new Date().toISOString(),
      count: 3,
      bookmarks: [
        { id: '1', tweetUrl: 'https://x.com/a/status/1' },
        { id: '2', tweetUrl: 'https://x.com/a/status/2' },
        { id: '3', tweetUrl: 'https://x.com/a/status/3' },
      ],
    });

    writeJson(configPath, {
      assistantProvider: 'codex',
      autoInvokeClaude: false,
      archiveFile: path.join(tmpDir, 'bookmarks.md'),
      pendingFile,
      stateFile: path.join(tmpDir, '.state', 'bookmarks-state.json'),
      timezone: 'America/Los_Angeles',
      twitter: { authToken: 'x', ct0: 'y' },
    });

    const result = await run({ configPath, limit: 2 });
    assert.strictEqual(result.success, true);

    const pending = readJson(pendingFile);
    assert.strictEqual(pending.bookmarks.length, 3);
    assert.strictEqual(pending.count, 3);
    assert.strictEqual(fs.existsSync(pendingFile + '.full'), false);
  });

  test('restores full pending when Codex invocation fails', async () => {
    // Avoid real network calls in tests: make invokeCodex fail fast.
    delete process.env.OPENAI_API_KEY;

    const pendingFile = path.join(tmpDir, '.state', 'pending-bookmarks.json');
    const configPath = path.join(tmpDir, 'smaug.config.json');

    writeJson(pendingFile, {
      generatedAt: new Date().toISOString(),
      count: 3,
      bookmarks: [
        { id: '1', tweetUrl: 'https://x.com/a/status/1' },
        { id: '2', tweetUrl: 'https://x.com/a/status/2' },
        { id: '3', tweetUrl: 'https://x.com/a/status/3' },
      ],
    });

    writeJson(configPath, {
      assistantProvider: 'codex',
      autoInvokeClaude: true,
      archiveFile: path.join(tmpDir, 'bookmarks.md'),
      pendingFile,
      stateFile: path.join(tmpDir, '.state', 'bookmarks-state.json'),
      timezone: 'America/Los_Angeles',
      codexModel: 'gpt-5-codex-mini',
      codexReasoningEffort: 'low',
      twitter: { authToken: 'x', ct0: 'y' },
    });

    const codexStub = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "codex 0.0.0-test"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n');
    const codexPath = path.join(binDir, 'codex');
    fs.writeFileSync(codexPath, codexStub);
    fs.chmodSync(codexPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;

    const result = await run({ configPath, limit: 2 });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);

    const pending = readJson(pendingFile);
    assert.strictEqual(pending.bookmarks.length, 3);
    assert.strictEqual(pending.count, 3);
    assert.strictEqual(fs.existsSync(pendingFile + '.full'), false);
  });
});
