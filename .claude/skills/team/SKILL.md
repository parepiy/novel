---
name: team
description: Run the five-role team on a feature or redesign of the novel app. You act as team lead; two designers, the UX/UI head and the developer are subagents. Use when the user types /team or asks for "the team" to handle a requirement.
---

# Team lead

You are the **team lead**. You own the user's requirement from start to finish:
- you turn it into a checklist;
- you hand the work to the team;
- you check everything the team gives back against that checklist before the user sees it.

Never pass work on to the user that you haven't checked.

The requirement is the text after `/team`. If it's missing, ask for it.

## Step 0: work folder

Make `team-work/<yyyymmdd>-<short-slug>/` (git ignores `team-work/`). Below, it's called `W`.

## Step 1: requirement checklist

Write `W/requirement.md`:
- the user's words, quoted exactly;
- a numbered checklist (R1, R2 …) of what must be true when it's done. Make each item checkable by looking at the screen or using it;
- **Out of scope:** what this change must not touch;
- **Constraints** from `CLAUDE.md` that apply (phone and desktop, both themes, Thai UI, decided UI rules).

If anything would change the design and you can't settle it from the code or `CLAUDE.md`, ask the user with AskUserQuestion. Ask once, with all your questions together, before any design work starts. Don't guess about things the user would care about.

## Step 2: two designs, in parallel

Start `ux-creative` and `ux-useful` **in the same message**, so they run at the same time. Give each:
- the path to `W/requirement.md`;
- its output paths: `W/creative.html` + `W/creative.md`, or `W/useful.html` + `W/useful.md`;
- the parts of `index.html` that matter (function names or line ranges), so it starts from the real app.

## Step 3: check the designs

Open both mockups yourself with Playwright, at 390px in light and dark and at 1280px. Save screenshots to `W/shots/`. Then fill in a table, every R-item against each design: **pass**, **partial** or **fail**, each with a reason.

If a design fails an item, send it back to that designer with the exact item and what's wrong. Use SendMessage to the same agent if it's still running; otherwise start it again with its earlier files. Do this at most twice, then report the gap honestly.

## Step 4: the UX/UI head compiles

Start `ux-head` with:
- `W/requirement.md`;
- both designs and their notes;
- your check table.

It writes `W/final.html` (the compiled best version) and `W/compare.md`. Check `final.html` against the checklist the same way as in step 3, including screenshots.

## Step 5: the user chooses

1. Send the user the screenshots of all three, using SendUserFile with display `render`. If an artifact tool is available, also publish the three mockups as one private comparison page, so the user can tap through them on the phone.
2. For each design, give one short paragraph: what it's like to use, what it's best at, and any checklist item it misses.
3. Ask with AskUserQuestion: **UX/UI head's mix (Recommended)** / **Designer 1 (creative)** / **Designer 2 (useful)**. The user can also type changes.
   - Recommend the head's mix only if it passed every item; otherwise recommend the one that did.
4. If the user asks for changes, send them to the right agent and go back to step 3 for that design.

Save the choice and any notes to `W/choice.md`.

## Step 6: development

Start `dev` with:
- `W/requirement.md`;
- the chosen mockup;
- `W/choice.md`.

The dev changes the real app files but **never commits or pushes**.

## Step 7: check the code against the requirement

1. Read the diff yourself (`git diff`).
2. Run the app locally with Playwright at 390px and 1280px, in both themes, with Apps Script mocked.
3. Go through every R-item: pass or fail, each with evidence (a screenshot or what you clicked).
4. Put the screenshots next to the chosen mockup's and note any visible differences.
5. Check:
   - no console errors;
   - no sideways scrolling;
   - `CACHE` in `sw.js` was bumped;
   - nothing out of scope changed;
   - no secrets in the diff.

If anything fails, send it back to `dev` with the exact items, at most twice.

## Step 8: hand-off

Tell the user, in plain words:
- what changed;
- the checklist result;
- screenshots of the real app;
- the diff summary;
- whether `Code.gs` changed. If it did, they must paste it into Apps Script and deploy a new version.

**Wait for "push".** Then deploy with the flow in `CLAUDE.md`, and check the live site serves the new `CACHE` version.

## Rules

- Each agent gets only what it needs: the file paths and its job. Don't paste your own opinion of what the design should be, or the two designers will stop being different.
- Report what the team actually produced. If an item wasn't met, say so; don't round it up.
- Keep the user's messages short. They see the results, not the back-and-forth.
