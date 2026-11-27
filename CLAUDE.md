# Novel library app

A Thai novel-library PWA for one person. The user writes to Claude in English; every word in the app's UI is Thai.

## How it's built

- **`index.html`** is the whole app: HTML, CSS and JS in one file, with no build step and no libraries. It's served by GitHub Pages from `main`.
- **Data:** a Google Sheet. The app reads it from the published CSV and writes through the Apps Script backend in `apps-script/Code.gs`. The user pastes that file into Apps Script and deploys a new version there themselves.
- **`sw.js`** is the offline cache. **Bump `CACHE` (`'novel-vNN'`) on every deploy**, or phones keep the old version.
- **Reminders** are sent by `.github/workflows/reminders.yml`, which runs `.github/scripts/send-reminders.js` (Web Push).
- **Covers** are image files at the repo root and in `covers/`.

## Who uses it and how

- Mostly an iPhone, in Safari and as the installed home-screen app (`body.standalone`).
- Sometimes a desktop.
- Both light and dark theme.

Every change must work:
- at 390px wide and at 1280px wide;
- in both themes;
- with no sideways scrolling;
- with tap targets of at least about 36px.

## UI rules the user has already decided

- **Colours:** use the CSS tokens on `:root` and `:root[data-theme]` (`--bg`, `--s1`, `--text`, `--mute`, `--grad`, `--chip-act` …). Don't hard-code new colours.
- **Popups:**
  - Titles and ✕ stay pinned while you scroll.
  - Forms open in their own popup, never tacked onto the bottom of a list.
- **Phones:**
  - No long-press actions; use visible buttons.
  - The bottom tab bar shows only in the installed app.
  - The top bar shrinks on scroll.
- **อ่านต่อ** opens the chapter of the next reminder first.

## Rules

- **Secrets:** never put the secret key, a GitHub token or the user's email in a file, a commit or the chat.
  - The secret lives in Apps Script → Project Settings → Script Properties → `SECRET`.
- **Pushing:** show what changed and wait for the user's "push" before deploying.
- **Deploy:**
  1. Commit on the session branch and push it.
  2. Make `main` match the branch:
     `git fetch origin main && git checkout -B main origin/main && git checkout <branch> -- . && git commit && git push origin main`
  3. Check `git diff origin/main <branch>` is empty.
  4. Switch back to the branch.
- **Testing:**
  - Start a local server: `python3 -m http.server 8765 --bind 127.0.0.1`.
  - Drive the page with Playwright at 390px and 1280px, in both themes.
  - Check for no console errors.
  - Mock Apps Script calls; never write to the real Sheet from a test.

## The team (`/team`)

For new features and redesigns, the user runs `/team <requirement>`. The main conversation becomes the **team lead** and works with four agents in `.claude/agents/`:

| Agent | Role |
|---|---|
| `ux-creative` | UX/UI designer 1: the most creative design |
| `ux-useful` | UX/UI designer 2: the most useful, practical design |
| `ux-head` | UX/UI head: compiles the best version from designers 1 and 2 |
| `dev` | Developer: writes the most optimised code for the design the user picks |

The whole flow is in `.claude/skills/team/SKILL.md`. Working files go in `team-work/`, which git ignores. Small fixes don't need the team.
