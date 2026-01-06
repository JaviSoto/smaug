# Smaug + Codex: Process Pending Bookmarks

Goal: take the pending bookmarks JSON (`pendingFile` from `./smaug.config.json`) and write a readable archive + knowledge files.

Important rules:
- Do not modify Smaug source code.
- Only write to the archive and knowledge paths specified by `./smaug.config.json`.
- If a bookmark has already been archived (same tweet URL), do not duplicate it.
- Prefer concise, factual summaries. Do not invent details.

Inputs:
- `./smaug.config.json` (paths + categories)
- `pendingFile` (bookmarks to process; includes expanded links + extracted content when available)

Outputs (from config):
- `archiveFile` (append new entries grouped by date)
- `categories.*.folder` files when `action` is `file`

Archive format (suggested):
- Group by day header (`# Monday, January 6, 2026`)
- One section per bookmark:
  - `## @user — <short title>`
  - quoted tweet text (1–3 lines if long)
  - bullet list:
    - Tweet URL
    - Expanded link(s)
    - Tags (if you can infer from domain/topic)
    - Filed link (if you created a knowledge file)

Filing rules:
- If the expanded link is a GitHub repo -> file into the `github` category folder (tool template).
- If it’s an article/newsletter/blog post -> file into the `article` category folder.
- Otherwise keep it as an archive-only entry.

Knowledge file guidance:
- Use YAML frontmatter with at least: `title`, `type`, `date_added`, `source`, `via` (tweet URL), `tags` (optional).
- Include a short summary (3–8 bullets) and relevant links.
