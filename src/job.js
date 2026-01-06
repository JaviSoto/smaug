/**
 * Smaug Scheduled Job
 *
 * Full two-phase workflow:
 * 1. Fetch bookmarks, expand links, extract content
 * 2. Invoke Claude Code for analysis and filing
 *
 * Can be used with:
 * - Cron: "0,30 * * * *" (every 30 min) - node /path/to/smaug/src/job.js
 * - Bree: Import and add to your Bree jobs array
 * - systemd timers: See README for setup
 * - Any other scheduler
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fetchAndPrepareBookmarks } from './processor.js';
import { loadConfig } from './config.js';
import { callCodexJson } from './codex_api.js';
import { applyArchiveUpdates, formatArchiveEntry, loadTextIfExists, writeTextAtomic } from './archive.js';

const JOB_NAME = 'smaug';
const LOCK_FILE = path.join(os.tmpdir(), 'smaug.lock');

// ============================================================================
// Lock Management - Prevents overlapping runs
// ============================================================================

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const { pid, timestamp } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      try {
        process.kill(pid, 0); // Check if process exists
        const age = Date.now() - timestamp;
        if (age < 20 * 60 * 1000) { // 20 minute timeout
          console.log(`[${JOB_NAME}] Previous run still in progress (PID ${pid}). Skipping.`);
          return false;
        }
        console.log(`[${JOB_NAME}] Stale lock found (${Math.round(age / 60000)}min old). Overwriting.`);
      } catch (e) {
        console.log(`[${JOB_NAME}] Removing stale lock (PID ${pid} no longer running)`);
      }
    } catch (e) {
      // Invalid lock file
    }
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
  return true;
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const { pid } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch (e) {}
}

// ============================================================================
// Claude Code Invocation
// ============================================================================

async function invokeClaudeCode(config, bookmarkCount, options = {}) {
  const timeout = config.claudeTimeout || 900000; // 15 minutes default
  const model = config.claudeModel || 'sonnet'; // or 'haiku' for faster/cheaper
  const trackTokens = options.trackTokens || false;

  // Specific tool permissions instead of full YOLO mode
  // Task is needed for parallel subagent processing
  const allowedTools = config.allowedTools || 'Read,Write,Edit,Glob,Grep,Bash,Task,TodoWrite';

  // Find claude binary - check common locations
  let claudePath = 'claude';
  const possiblePaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(process.env.HOME || '', '.claude/local/claude'),
    path.join(process.env.HOME || '', '.local/bin/claude'),
    path.join(process.env.HOME || '', 'Library/Application Support/Herd/config/nvm/versions/node/v20.19.4/bin/claude'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      claudePath = p;
      break;
    }
  }
  // Also check via which if we haven't found it
  if (claudePath === 'claude') {
    try {
      claudePath = execSync('which claude', { encoding: 'utf8' }).trim() || 'claude';
    } catch {
      // which failed, stick with 'claude'
    }
  }

  // Dramatic dragon reveal with fire animation
  const showDragonReveal = async (totalBookmarks) => {
    // Fire animation for 1.5 seconds
    process.stdout.write('\n');
    const fireFramesIntro = ['🔥', '🔥🔥', '🔥🔥🔥', '🔥🔥🔥🔥', '🔥🔥🔥🔥🔥'];
    for (let i = 0; i < 10; i++) {
      const frame = fireFramesIntro[i % fireFramesIntro.length];
      process.stdout.write(`\r  ${frame.padEnd(12)}`);
      await new Promise(r => setTimeout(r, 150));
    }

    // Clear and reveal
    process.stdout.write('\r                    \r');
    process.stdout.write(`  Wait... that's not Claude... it's

  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥  🔥
       _____ __  __   _   _   _  ____
      / ____|  \\/  | / \\ | | | |/ ___|
      \\___ \\| |\\/| |/ _ \\| | | | |  _
       ___) | |  | / ___ \\ |_| | |_| |
      |____/|_|  |_/_/  \\_\\___/ \\____|

  🐉 The dragon stirs... ${totalBookmarks} treasure${totalBookmarks !== 1 ? 's' : ''} to hoard!
`);
  };

  await showDragonReveal(bookmarkCount);

  return new Promise((resolve) => {
    const pendingPath = config.pendingFile || './.state/pending-bookmarks.json';
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--model', model,
      '--allowedTools', allowedTools,
      '--',
      `Process the ${bookmarkCount} bookmark(s) in ${pendingPath} following the instructions in ./.claude/commands/process-bookmarks.md. Read that file first, then process each bookmark.`
    ];

    // Ensure PATH includes common node locations for the claude shebang
    const nodePaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      process.env.NVM_BIN,
      path.join(process.env.HOME || '', 'Library/Application Support/Herd/config/nvm/versions/node/v20.19.4/bin'),
      path.join(process.env.HOME || '', '.local/bin'),
      path.join(process.env.HOME || '', '.bun/bin'),
    ];
    const enhancedPath = [...nodePaths, process.env.PATH || ''].join(':');

    // Get ANTHROPIC_API_KEY from config or env only
    // Note: Don't parse from ~/.zshrc - OAuth tokens (sk-ant-oat01-*) might be
    // incorrectly stored there and would override valid OAuth credentials
    const apiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

    // Build clean environment, removing nested Claude detection vars
    // These vars can cause issues when Claude is spawned from within another Claude session
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(claudePath, args, {
      cwd: config.projectRoot || process.cwd(),
      env: {
        ...cleanEnv,
        PATH: enhancedPath,
        ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let lastText = '';
    let filesWritten = [];
    let bookmarksProcessed = 0;
    let totalBookmarks = bookmarkCount;

    // Track parallel tasks
    const parallelTasks = new Map(); // taskId -> { description, startTime, status }
    let tasksSpawned = 0;
    let tasksCompleted = 0;

    // Token usage tracking
    const tokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      subagentInput: 0,
      subagentOutput: 0,
      model: model,
      subagentModel: null
    };

    // Helper to format time elapsed
    const startTime = Date.now();
    const elapsed = () => {
      const ms = Date.now() - startTime;
      const secs = Math.floor(ms / 1000);
      return secs < 60 ? `${secs}s` : `${Math.floor(secs/60)}m ${secs%60}s`;
    };

    // Progress bar helper
    const progressBar = (current, total, width = 20) => {
      const pct = Math.min(current / total, 1);
      const filled = Math.round(pct * width);
      const empty = width - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);
      return `[${bar}] ${current}/${total}`;
    };

    // Dragon status messages
    const dragonSays = [
      '🐉 *sniff sniff* Fresh bookmarks detected...',
      '🔥 Breathing fire on these tweets...',
      '💎 Adding treasures to the hoard...',
      '🏔️ Guarding the mountain of knowledge...',
      '⚔️ Vanquishing duplicate bookmarks...',
      '🌋 The dragon\'s flames illuminate the data...',
    ];
    let dragonMsgIndex = 0;
    const nextDragonMsg = () => dragonSays[dragonMsgIndex++ % dragonSays.length];

    // Track one-time messages to avoid duplicates
    const shownMessages = new Set();

    // Animated fire spinner with rotating dragon messages
    const fireFrames = [
      '  🔥    ',
      ' 🔥🔥   ',
      '🔥🔥🔥  ',
      ' 🔥🔥🔥 ',
      '  🔥🔥🔥',
      '   🔥🔥 ',
      '    🔥  ',
      '   🔥   ',
      '  🔥🔥  ',
      ' 🔥 🔥  ',
      '🔥  🔥  ',
      '🔥   🔥 ',
      ' 🔥  🔥 ',
      '  🔥 🔥 ',
      '   🔥🔥 ',
    ];
    const spinnerMessages = [
      'Breathing fire on bookmarks',
      'Examining the treasures',
      'Sorting the hoard',
      'Polishing the gold',
      'Counting coins',
      'Guarding the lair',
      'Hunting for gems',
      'Cataloging riches',
    ];
    let fireFrame = 0;
    let spinnerMsgFrame = 0;
    let lastSpinnerLine = '';
    let spinnerActive = true;
    let currentSpinnerMsg = spinnerMessages[0];

    // Change message every 10 seconds
    const msgInterval = setInterval(() => {
      if (!spinnerActive) return;
      spinnerMsgFrame = (spinnerMsgFrame + 1) % spinnerMessages.length;
      currentSpinnerMsg = spinnerMessages[spinnerMsgFrame];
    }, 10000);

    const spinnerInterval = setInterval(() => {
      if (!spinnerActive) return;
      fireFrame = (fireFrame + 1) % fireFrames.length;
      const flame = fireFrames[fireFrame];
      const spinnerLine = `\r  ${flame} ${currentSpinnerMsg}... [${elapsed()}]`;
      process.stdout.write(spinnerLine + '          '); // Extra spaces to clear previous longer messages
      lastSpinnerLine = spinnerLine;
    }, 150);

    // Start the spinner with a patience message
    process.stdout.write('\n  ⏳ Dragons are patient hunters... this may take a moment.\n');
    lastSpinnerLine = '  🔥     Processing...';
    process.stdout.write(lastSpinnerLine);

    // Helper to clear spinner and print a status line
    const printStatus = (msg) => {
      // Clear current line and print message
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      process.stdout.write(msg);
    };

    // Helper to stop spinner completely
    const stopSpinner = () => {
      spinnerActive = false;
      clearInterval(spinnerInterval);
      clearInterval(msgInterval);
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    };

    // Buffer for incomplete JSON lines
    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      // Handle streaming data that may split across chunks
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      // Keep the last incomplete line in the buffer
      lineBuffer = lines.pop() || '';

      // Parse streaming JSON and extract progress info
      for (const line of lines) {
        if (!line.trim()) continue;

        // Skip lines that don't look like JSON events
        if (!line.startsWith('{')) continue;

        try {
          const event = JSON.parse(line);

          // Show assistant text as it streams (filtered)
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text !== lastText) {
                const newPart = block.text.slice(lastText.length);
                if (newPart && newPart.length > 50) {
                  // Only show final summaries
                  if (newPart.includes('Processed') && newPart.includes('bookmark')) {
                    process.stdout.write(`\n💬 ${newPart.trim().slice(0, 200)}${newPart.length > 200 ? '...' : ''}\n`);
                  }
                }
                lastText = block.text;
              }

              // Track tool usage for progress messages
              if (block.type === 'tool_use') {
                const toolName = block.name;
                const input = block.input || {};

                if (toolName === 'Write' && input.file_path) {
                  const fileName = input.file_path.split('/').pop();
                  const dir = input.file_path.includes('/knowledge/tools/') ? 'tools' :
                             input.file_path.includes('/knowledge/articles/') ? 'articles' : '';
                  filesWritten.push(fileName);
                  if (dir) {
                    printStatus(`    💎 Hoarded → ${dir}/${fileName}\n`);
                  } else if (fileName === 'bookmarks.md') {
                    bookmarksProcessed++;
                    const fireIntensity = '🔥'.repeat(Math.min(Math.ceil(bookmarksProcessed / 2), 5));
                    printStatus(`  ${fireIntensity} ${progressBar(bookmarksProcessed, totalBookmarks)} [${elapsed()}]`);
                  } else {
                    printStatus(`    💎 ${fileName}\n`);
                  }
                } else if (toolName === 'Edit' && input.file_path) {
                  const fileName = input.file_path.split('/').pop();
                  if (fileName === 'bookmarks.md') {
                    bookmarksProcessed++;
                    const fireIntensity = '🔥'.repeat(Math.min(Math.ceil(bookmarksProcessed / 2), 5));
                    printStatus(`  ${fireIntensity} ${progressBar(bookmarksProcessed, totalBookmarks)} [${elapsed()}]`);
                  } else if (fileName === 'pending-bookmarks.json') {
                    printStatus(`  🐉 *licks claws clean* Tidying the lair...\n`);
                  }
                } else if (toolName === 'Read' && input.file_path) {
                  const fileName = input.file_path.split('/').pop();
                  if (fileName === 'pending-bookmarks.json' && !shownMessages.has('eye')) {
                    shownMessages.add('eye');
                    printStatus(`  👁️  The dragon's eye opens... surveying treasures...\n`);
                  } else if (fileName === 'process-bookmarks.md' && !shownMessages.has('scrolls')) {
                    shownMessages.add('scrolls');
                    printStatus(`  📜 Consulting the ancient scrolls...\n`);
                  }
                } else if (toolName === 'Task') {
                  const desc = input.description || `batch ${tasksSpawned + 1}`;
                  // Only count if we haven't seen this task description
                  const taskKey = `task-${desc}`;
                  if (!parallelTasks.has(taskKey)) {
                    tasksSpawned++;
                    parallelTasks.set(taskKey, {
                      description: desc,
                      startTime: Date.now(),
                      status: 'running'
                    });
                    printStatus(`  🐲 Summoning dragon minion: ${desc}\n`);
                    if (tasksSpawned > 1) {
                      printStatus(`     🔥 ${tasksSpawned} dragons now circling the hoard\n`);
                    }
                  }
                } else if (toolName === 'Bash') {
                  const cmd = input.command || '';
                  if (cmd.includes('jq') && cmd.includes('bookmarks')) {
                    printStatus(`  ⚡ ${nextDragonMsg()}\n`);
                  }
                }
              }
            }
          }

          // Track task completions from tool results
          if (event.type === 'user' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result' && !block.is_error && block.tool_use_id) {
                // Check if this looks like a Task completion and we haven't counted it
                const content = typeof block.content === 'string' ? block.content : '';
                const toolId = block.tool_use_id;
                if ((content.includes('Processed') || content.includes('completed')) &&
                    !shownMessages.has(`task-done-${toolId}`)) {
                  shownMessages.add(`task-done-${toolId}`);
                  tasksCompleted++;
                  if (tasksSpawned > 0 && tasksCompleted <= tasksSpawned) {
                    const pct = Math.round((tasksCompleted / tasksSpawned) * 100);
                    const flames = '🔥'.repeat(Math.ceil(pct / 20));
                    printStatus(`  🐲 Dragon minion returns! ${flames} (${tasksCompleted}/${tasksSpawned})\n`);
                  }
                }
              }
            }
          }

          // Track token usage from result event
          if (event.type === 'result' && event.usage) {
            tokenUsage.input = event.usage.input_tokens || 0;
            tokenUsage.output = event.usage.output_tokens || 0;
            tokenUsage.cacheRead = event.usage.cache_read_input_tokens || 0;
            tokenUsage.cacheWrite = event.usage.cache_creation_input_tokens || 0;
          }

          // Track subagent token usage from Task results
          if (event.type === 'user' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result' && block.content) {
                // Try to parse subagent usage from result
                const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                const usageMatch = content.match(/usage.*?input.*?(\d+).*?output.*?(\d+)/i);
                if (usageMatch) {
                  tokenUsage.subagentInput += parseInt(usageMatch[1], 10);
                  tokenUsage.subagentOutput += parseInt(usageMatch[2], 10);
                }
                // Detect subagent model from content
                if (!tokenUsage.subagentModel && content.includes('haiku')) {
                  tokenUsage.subagentModel = 'haiku';
                } else if (!tokenUsage.subagentModel && content.includes('sonnet')) {
                  tokenUsage.subagentModel = 'sonnet';
                }
              }
            }
          }

          // Show result summary
          if (event.type === 'result') {
            stopSpinner();

            // Randomized hoard descriptions by size tier
            const hoardDescriptions = {
              small: [
                'A Few Coins',
                'Sparse',
                'Humble Beginnings',
                'First Treasures',
                'A Modest Start'
              ],
              medium: [
                'Glittering',
                'Growing Nicely',
                'Respectable Pile',
                'Gleaming Hoard',
                'Handsome Collection'
              ],
              large: [
                'Overflowing',
                'Mountain of Gold',
                'Legendary Hoard',
                'Dragon\'s Fortune',
                'Vast Riches'
              ]
            };

            const tier = totalBookmarks > 15 ? 'large' : totalBookmarks > 7 ? 'medium' : 'small';
            const descriptions = hoardDescriptions[tier];
            const hoardStatus = descriptions[Math.floor(Math.random() * descriptions.length)];

            // Build token usage display if tracking enabled
            let tokenDisplay = '';
            if (trackTokens && (tokenUsage.input > 0 || tokenUsage.output > 0)) {
              // Pricing per million tokens (as of 2024)
              const pricing = {
                'sonnet': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
                'haiku': { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.30 },
                'opus': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 }
              };

              const mainPricing = pricing[tokenUsage.model] || pricing.sonnet;
              const subPricing = pricing[tokenUsage.subagentModel || tokenUsage.model] || mainPricing;

              // Calculate costs
              const mainInputCost = (tokenUsage.input / 1_000_000) * mainPricing.input;
              const mainOutputCost = (tokenUsage.output / 1_000_000) * mainPricing.output;
              const cacheReadCost = (tokenUsage.cacheRead / 1_000_000) * mainPricing.cacheRead;
              const cacheWriteCost = (tokenUsage.cacheWrite / 1_000_000) * mainPricing.cacheWrite;
              const subInputCost = (tokenUsage.subagentInput / 1_000_000) * subPricing.input;
              const subOutputCost = (tokenUsage.subagentOutput / 1_000_000) * subPricing.output;

              const totalCost = mainInputCost + mainOutputCost + cacheReadCost + cacheWriteCost + subInputCost + subOutputCost;

              const formatNum = (n) => n.toLocaleString();
              const formatCost = (c) => c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`;

              tokenDisplay = `
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📊 TOKEN USAGE
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Main (${tokenUsage.model}):
    Input:       ${formatNum(tokenUsage.input).padStart(10)} tokens  ${formatCost(mainInputCost)}
    Output:      ${formatNum(tokenUsage.output).padStart(10)} tokens  ${formatCost(mainOutputCost)}
    Cache Read:  ${formatNum(tokenUsage.cacheRead).padStart(10)} tokens  ${formatCost(cacheReadCost)}
    Cache Write: ${formatNum(tokenUsage.cacheWrite).padStart(10)} tokens  ${formatCost(cacheWriteCost)}
${tokenUsage.subagentInput > 0 || tokenUsage.subagentOutput > 0 ? `
  Subagents (${tokenUsage.subagentModel || 'unknown'}):
    Input:       ${formatNum(tokenUsage.subagentInput).padStart(10)} tokens  ${formatCost(subInputCost)}
    Output:      ${formatNum(tokenUsage.subagentOutput).padStart(10)} tokens  ${formatCost(subOutputCost)}
` : ''}
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  💰 TOTAL COST: ${formatCost(totalCost)}
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
            }

            process.stdout.write(`

  🔥🔥🔥  THE DRAGON'S HOARD GROWS!  🔥🔥🔥

              🐉
            /|  |\\
           / |💎| \\      Victory!
          /  |__|  \\
         /  /    \\  \\
        /__/  💰  \\__\\

  ⏱️  Quest Duration:  ${elapsed()}
  📦  Bookmarks:       ${totalBookmarks} processed
  🐲  Dragon Minions:  ${tasksSpawned > 0 ? tasksSpawned + ' summoned' : 'solo hunt'}
  🏔️  Hoard Status:    ${hoardStatus}
${tokenDisplay}
  🐉 Smaug rests... until the next hoard arrives.

`);
          }
        } catch (e) {
          // JSON parse failed - silently ignore (don't print raw JSON)
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    const timeoutId = setTimeout(() => {
      stopSpinner();
      proc.kill('SIGTERM');
      resolve({
        success: false,
        error: `Timeout after ${timeout}ms`,
        stdout,
        stderr,
        exitCode: -1
      });
    }, timeout);

    proc.on('close', (code) => {
      stopSpinner();
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ success: true, output: stdout, tokenUsage });
      } else {
        resolve({
          success: false,
          error: `Exit code ${code}`,
          stdout,
          stderr,
          exitCode: code,
          tokenUsage
        });
      }
    });

    proc.on('error', (err) => {
      stopSpinner();
      clearTimeout(timeoutId);
      resolve({
        success: false,
        error: err.message,
        stdout,
        stderr,
        exitCode: -1
      });
    });
  });
}

// ============================================================================
// Codex Invocation (OpenAI Codex CLI)
// ============================================================================

async function invokeCodex(config, bookmarkCount) {
  const pendingPath = config.pendingFile || './.state/pending-bookmarks.json';
  let pendingData;
  try {
    pendingData = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch (e) {
    return { success: false, error: `Could not read pending file: ${e.message}` };
  }

  const bookmarks = (pendingData.bookmarks || []).slice(0, bookmarkCount);
  const byTweetUrl = new Map(bookmarks.map(b => [b.tweetUrl, b]));

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['entries'],
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['tweet_url', 'date', 'author_username', 'title', 'excerpt', 'tags', 'expanded_links', 'notes'],
          properties: {
            tweet_url: { type: 'string' },
            date: { type: 'string' },
            author_username: { type: 'string' },
            title: { type: 'string' },
            excerpt: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            expanded_links: { type: 'array', items: { type: 'string' } },
            notes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['category', 'title', 'source_url', 'summary_bullets', 'tags'],
                properties: {
                  category: { type: 'string', enum: ['github', 'article'] },
                  title: { type: 'string' },
                  source_url: { type: 'string' },
                  summary_bullets: { type: 'array', items: { type: 'string' } },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  };

  const payloadForModel = bookmarks.map((b) => ({
    tweet_url: b.tweetUrl,
    tweet_id: b.id,
    date: b.date,
    author_username: b.author,
    author_name: b.authorName,
    text: b.text,
    links: (b.links || []).map((l) => ({
      expanded: l.expanded,
      type: l.type,
      content: l.content
        ? (l.type === 'github'
          ? {
            name: l.content.name,
            fullName: l.content.fullName,
            description: l.content.description,
            stars: l.content.stars,
            language: l.content.language,
            topics: l.content.topics,
            readme: (l.content.readme || '').slice(0, 2500),
          }
          : { text: (l.content.text || '').slice(0, 2500), paywalled: l.content.paywalled })
        : null,
    })),
    reply_context: b.replyContext || null,
    quote_context: b.quoteContext || null,
  }));

  const inputText = [
    'You are Smaug, a Twitter/X bookmarks archivist.',
    '',
    'Return STRICT JSON matching the provided schema. No markdown, no prose.',
    'For each input bookmark, produce one entry. Keep titles short (<= 80 chars) and tags <= 8.',
    'Only create notes for GitHub repos and articles; omit notes otherwise.',
    '',
    'Input bookmarks JSON:',
    JSON.stringify(payloadForModel),
  ].join('\n');

  let modelResult;
  try {
    console.log(`[${JOB_NAME}] OpenAI: requesting ${bookmarkCount} bookmark summary via model ${config.codexModel || 'codex-mini-latest'} (${config.codexReasoningEffort || 'default'} reasoning)`);
    modelResult = await callCodexJson({
      model: config.codexModel || 'codex-mini-latest',
      reasoningEffort: config.codexReasoningEffort,
      schema,
      inputText,
      maxOutputTokens: Math.min(12000, 1200 * Math.max(1, bookmarkCount)),
    });
    console.log(`[${JOB_NAME}] OpenAI: response received`);
  } catch (e) {
    return { success: false, error: e.message };
  }

  const entries = modelResult.parsed?.entries;
  if (!Array.isArray(entries)) {
    return { success: false, error: 'Model output missing entries[]' };
  }

  // Load archive once for de-dupe checks.
  const archivePath = config.archiveFile;
  const existingArchive = loadTextIfExists(archivePath);
  const existingText = existingArchive;

  const grouped = new Map(); // date -> { date, bodyParts: [] }

  const knowledgeWrites = [];
  const filedByTweet = new Map(); // tweet_url -> [paths]

  const todayIso = new Date().toISOString().slice(0, 10);

  const slugify = (s) => String(s || 'note')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) || 'note';

  for (const entry of entries) {
    const tweetUrl = String(entry.tweet_url || '').trim();
    if (!tweetUrl) return { success: false, error: 'Model entry missing tweet_url' };
    const src = byTweetUrl.get(tweetUrl);
    if (!src) {
      return { success: false, error: `Model returned unknown tweet_url: ${tweetUrl}` };
    }

    const tweetId = src.id || (tweetUrl.match(/status\/(\d+)/)?.[1] ?? 'unknown');

    // Build knowledge files first (optional)
    const filedPaths = [];
    for (const note of entry.notes || []) {
      const category = note.category;
      const categoryCfg = config.categories?.[category];
      if (!categoryCfg || categoryCfg.action !== 'file' || !categoryCfg.folder) continue;

      const folder = categoryCfg.folder;
      const filename = `${slugify(note.title)}-${tweetId}.md`;
      const filePath = path.join(folder, filename);
      if (!fs.existsSync(filePath)) {
        const tags = Array.isArray(note.tags) ? note.tags.filter(Boolean).slice(0, 20) : [];
        const frontmatter = [
          '---',
          `title: "${String(note.title || '').replace(/"/g, '\\"')}"`,
          `type: ${categoryCfg.template || category}`,
          `date_added: ${todayIso}`,
          `source: "${String(note.source_url || '').replace(/"/g, '\\"')}"`,
          `tags: [${tags.map(t => String(t).replace(/[^a-z0-9_-]/gi, '')).filter(Boolean).join(', ')}]`,
          `via: "Twitter bookmark from @${src.author || 'unknown'}"`,
          '---',
          '',
        ].join('\n');

        const bullets = Array.isArray(note.summary_bullets) ? note.summary_bullets.slice(0, 10) : [];
        const body = [
          ...bullets.map(b => `- ${String(b).trim()}`),
          '',
          '## Links',
          '',
          `- ${note.source_url}`,
          `- ${tweetUrl}`,
          '',
        ].join('\n');

        knowledgeWrites.push({ filePath, content: frontmatter + body });
      }
      filedPaths.push(filePath);
    }

    filedByTweet.set(tweetUrl, filedPaths);

    // De-dupe against existing archive.
    if (existingText.includes(`- Tweet URL: ${tweetUrl}`)) {
      continue;
    }

    const date = entry.date || src.date;
    const group = grouped.get(date) || { date, bodyParts: [] };
    group.bodyParts.push(formatArchiveEntry({
      tweet_url: tweetUrl,
      date,
      author_username: entry.author_username || src.author,
      title: entry.title,
      excerpt: entry.excerpt || src.text,
      tags: entry.tags,
      expanded_links: entry.expanded_links,
    }, filedPaths.map(p => path.relative(path.dirname(archivePath), p))));
    grouped.set(date, group);
  }

  // Write knowledge files (best-effort, but fail fast on IO issues).
  try {
    for (const w of knowledgeWrites) {
      writeTextAtomic(w.filePath, w.content);
    }
  } catch (e) {
    return { success: false, error: `Failed writing knowledge files: ${e.message}` };
  }

  const groups = [...grouped.values()]
    .map(g => ({ date: g.date, body: g.bodyParts.join('') }))
    // Newest-first: relying on date strings is lossy; keep input order by default.
    ;

  if (groups.length) {
    const updated = applyArchiveUpdates(existingArchive, groups);
    try {
      writeTextAtomic(archivePath, updated);
    } catch (e) {
      return { success: false, error: `Failed writing archive: ${e.message}` };
    }
  }

  return { success: true, tokenUsage: modelResult.usage };
}

function resolveAssistantProvider(config) {
  const raw = config.assistantProvider;
  if (raw === undefined || raw === null || raw === '') {
    return 'claude';
  }

  const provider = String(raw).toLowerCase();
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';

  throw new Error(
    `Invalid assistantProvider '${raw}'. Expected 'claude' or 'codex'.`
  );
}

// ============================================================================
// Webhook Notifications (Optional)
// ============================================================================

async function sendWebhook(config, payload) {
  if (!config.webhookUrl) return;

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`Webhook error: ${error.message}`);
  }
}

function formatDiscordPayload(title, description, success = true) {
  return {
    embeds: [{
      title,
      description,
      color: success ? 0x00ff00 : 0xff0000,
      timestamp: new Date().toISOString()
    }]
  };
}

function formatSlackPayload(title, description, success = true) {
  return {
    text: title,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${success ? '✅' : '❌'} ${title}` }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: description }
      }
    ]
  };
}

async function notify(config, title, description, success = true) {
  if (!config.webhookUrl) return;

  let payload;
  if (config.webhookType === 'slack') {
    payload = formatSlackPayload(title, description, success);
  } else {
    // Default to Discord format
    payload = formatDiscordPayload(title, description, success);
  }

  await sendWebhook(config, payload);
}

// ============================================================================
// Main Job Runner
// ============================================================================

export async function run(options = {}) {
  const startTime = Date.now();
  const now = new Date().toISOString();
  const config = loadConfig(options.configPath);

  console.log(`[${now}] Starting smaug job...`);

  // Overlap protection
  if (!acquireLock()) {
    return { success: true, skipped: true };
  }

  const fullFile = config.pendingFile + '.full';
  let signalCleanup = null;
  const restoreFullPendingForRetry = (reason) => {
    try {
      if (!fs.existsSync(fullFile)) return;
      fs.copyFileSync(fullFile, config.pendingFile);
      fs.unlinkSync(fullFile);
      if (reason) {
        console.log(`[${now}] Restored full pending file (${reason})`);
      } else {
        console.log(`[${now}] Restored full pending file`);
      }
    } catch (e) {
      console.error(`[${now}] Failed to restore full pending file:`, e.message);
    }
  };

  try {
    // Check for existing pending bookmarks first
    let pendingData = null;
    let bookmarkCount = 0;

    if (fs.existsSync(config.pendingFile)) {
      try {
        pendingData = JSON.parse(fs.readFileSync(config.pendingFile, 'utf8'));
        bookmarkCount = pendingData.bookmarks?.length || 0;

        // Apply --limit if specified (process subset of pending)
        const limit = options.limit;
        if (limit && limit > 0 && bookmarkCount > limit) {
          console.log(`[${now}] Limiting to ${limit} of ${bookmarkCount} pending bookmarks`);
          pendingData.bookmarks = pendingData.bookmarks.slice(0, limit);
          bookmarkCount = limit;
          // Write limited subset back (temporarily)
          fs.writeFileSync(fullFile, JSON.stringify(
            JSON.parse(fs.readFileSync(config.pendingFile, 'utf8')), null, 2
          ));
          pendingData.count = bookmarkCount;
          fs.writeFileSync(config.pendingFile, JSON.stringify(pendingData, null, 2));

          // If the process is interrupted mid-run, restore the full pending list
          // so we don't silently "lose" items.
          const onInterrupt = (sig) => {
            restoreFullPendingForRetry(`interrupted by ${sig}`);
            process.exit(sig === 'SIGINT' ? 130 : 143);
          };
          process.on('SIGINT', onInterrupt);
          process.on('SIGTERM', onInterrupt);
          signalCleanup = () => {
            process.off('SIGINT', onInterrupt);
            process.off('SIGTERM', onInterrupt);
          };
        }
      } catch (e) {
        // Invalid pending file, will fetch fresh
      }
    }

    // Phase 1: Fetch new bookmarks (merges with existing pending)
    if (bookmarkCount === 0 || options.forceFetch) {
      console.log(`[${now}] Phase 1: Fetching and preparing bookmarks...`);
      const prepResult = await fetchAndPrepareBookmarks(options);

      // Re-read pending file after fetch
      if (fs.existsSync(config.pendingFile)) {
        pendingData = JSON.parse(fs.readFileSync(config.pendingFile, 'utf8'));
        bookmarkCount = pendingData.bookmarks?.length || 0;
      }

      if (prepResult.count > 0) {
        console.log(`[${now}] Fetched ${prepResult.count} new bookmarks`);
      }
    } else {
      console.log(`[${now}] Found ${bookmarkCount} pending bookmarks, skipping fetch`);
    }

    if (bookmarkCount === 0) {
      console.log(`[${now}] No bookmarks to process`);
      return { success: true, count: 0, duration: Date.now() - startTime };
    }

    console.log(`[${now}] Processing ${bookmarkCount} bookmarks`);

    // Track IDs we're about to process
    const idsToProcess = pendingData.bookmarks.map(b => b.id);

    // Phase 2: Assistant analysis (if enabled)
    if (config.autoInvokeClaude !== false) {
      const provider = resolveAssistantProvider(config);
      console.log(
        `[${now}] Phase 2: Invoking ${provider === 'codex' ? 'Codex' : 'Claude Code'} for analysis...`
      );

      const assistantResult = provider === 'codex'
        ? await invokeCodex(config, bookmarkCount)
        : await invokeClaudeCode(config, bookmarkCount, { trackTokens: options.trackTokens });

      if (assistantResult.success) {
        console.log(`[${now}] Analysis complete`);

        // Remove processed IDs from pending file
        // If we used --limit, restore from .full file first
        let sourceData;
        if (fs.existsSync(fullFile)) {
          sourceData = JSON.parse(fs.readFileSync(fullFile, 'utf8'));
          fs.unlinkSync(fullFile); // Clean up .full file
        } else if (fs.existsSync(config.pendingFile)) {
          sourceData = JSON.parse(fs.readFileSync(config.pendingFile, 'utf8'));
        }

        if (sourceData) {
          const processedIds = new Set(idsToProcess);
          const remaining = sourceData.bookmarks.filter(b => !processedIds.has(b.id));

          fs.writeFileSync(config.pendingFile, JSON.stringify({
            generatedAt: sourceData.generatedAt,
            count: remaining.length,
            bookmarks: remaining
          }, null, 2));

          console.log(`[${now}] Cleaned up ${idsToProcess.length} processed bookmarks, ${remaining.length} remaining`);
        }

        // Send success notification
        await notify(
          config,
          'Bookmarks Processed',
          `**New:** ${bookmarkCount} bookmarks archived`,
          true
        );

        return {
          success: true,
          count: bookmarkCount,
          duration: Date.now() - startTime,
          output: assistantResult.output,
          tokenUsage: assistantResult.tokenUsage
        };

      } else {
        // Claude failed - restore full pending file for retry
        restoreFullPendingForRetry('for retry');

        console.error(`[${now}] Assistant failed:`, assistantResult.error);

        await notify(
          config,
          'Bookmark Processing Failed',
          `Prepared ${bookmarkCount} bookmarks but analysis failed:\n${assistantResult.error}`,
          false
        );

        return {
          success: false,
          count: bookmarkCount,
          duration: Date.now() - startTime,
          error: assistantResult.error
        };
      }
    } else {
      // Auto-invoke disabled - just fetch
      console.log(
        `[${now}] Auto-invoke disabled. Run 'smaug process' to prepare pending bookmarks, then invoke Claude Code/Codex manually.`
      );

      // If we used --limit, restore the full pending list before returning.
      restoreFullPendingForRetry('auto-invoke disabled');

      return {
        success: true,
        count: bookmarkCount,
        duration: Date.now() - startTime,
        pendingFile: config.pendingFile
      };
    }

  } catch (error) {
    console.error(`[${now}] Job error:`, error.message);

    restoreFullPendingForRetry('after error');

    await notify(
      config,
      'Smaug Job Failed',
      `Error: ${error.message}`,
      false
    );

    return {
      success: false,
      error: error.message,
      duration: Date.now() - startTime
    };
  } finally {
    if (signalCleanup) {
      signalCleanup();
    }
    releaseLock();
  }
}

// ============================================================================
// Bree-compatible export
// ============================================================================

export default {
  name: JOB_NAME,
  interval: '*/30 * * * *', // Every 30 minutes
  timezone: 'America/New_York',
  run
};

// ============================================================================
// Direct execution
// ============================================================================

if (process.argv[1] && process.argv[1].endsWith('job.js')) {
  run().then(result => {
    // Exit silently - the dragon output is enough
    process.exit(result.success ? 0 : 1);
  });
}
