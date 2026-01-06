# Smaug + Codex: Process Pending Bookmarks

Goal: take the pending bookmarks JSON (`pendingFile` from `./smaug.config.json`) and update the archive + knowledge files.

Hard rules:
- Do not modify Smaug source code.
- Only write to the archive and knowledge paths specified by `./smaug.config.json`.
- Do not perform any “agent pre-flight” routines. Do not read anything under `~/.codex/` (notes, memory, etc.).
- Do not print or “inspect” the full archive file contents (it can be huge). Do not use `tail`/`sed` to view large sections.
- Avoid patch-style editing workflows. Prefer small deterministic scripts to update files without dumping them to the console.
- If a bookmark has already been archived (same tweet URL), do not duplicate it.
- Prefer concise, factual summaries. Do not invent details.

Inputs:
- `./smaug.config.json` (paths + categories)
- `pendingFile` (bookmarks to process; includes expanded links + extracted content when available)

Outputs (from config):
- `archiveFile` (prepend new entries grouped by date; newest-first)
- `categories.*.folder` files when `action` is `file`

Archive format:
- Group by day header: `# Monday, January 6, 2026`
- Under each day, one section per bookmark:
  - `## @user — <short title>`
  - quoted tweet text (1–3 lines if long)
  - bullets:
    - Tweet URL
    - Expanded link(s) (if any)
    - Tags (if you can infer)
    - Filed link (if you created a knowledge file)

Filing rules:
- If an expanded link is a GitHub repo -> file into the `github` category folder (use the `tool` template).
- If it’s an article/newsletter/blog post -> file into the `article` category folder.
- Otherwise keep it as an archive-only entry.

Knowledge file guidance:
- YAML frontmatter: `title`, `type`, `date_added`, `source`, `via` (tweet URL), `tags` (optional).
- Body: 3–8 bullet summary + relevant links.

Implementation guidance (important):
- For each bookmark:
  - Compute the archive block text (header + section).
  - Before writing, de-dupe by tweet URL against the archive text using a cheap substring check.
- Update `archiveFile` by *prepending* new blocks using a small `python3` script so you never need to view the file:

  1) Write the new content you want to add to a temp file (e.g. `/tmp/smaug-archive-additions.md`).
  2) Run a script like:

     `python3 - <<'PY'`
     `import pathlib`
     `archive = pathlib.Path("...")`
     `additions = pathlib.Path("/tmp/smaug-archive-additions.md").read_text()`
     `existing = archive.read_text() if archive.exists() else ""`
     `archive.write_text(additions + ("\n" if additions and not additions.endswith("\n") else "") + existing)`
     `PY`

- If you need to insert under an existing day header, do it in Python by splitting on the first occurrence of the header line and inserting there; do not print the file.
