# Repository instructions

## Publish changes by default

After completing changes in this repository, publish them unless the user explicitly says otherwise. A local preview alone does not complete the task.

- Run the relevant checks and build before publishing.
- Commit the completed changes and push to `main` to trigger the existing GitHub Pages workflow. Reconcile upstream changes without overwriting unrelated work.
- Wait for the deployment workflow to succeed, then verify the live site at https://ryanlmelvin.github.io/walk-advisor/ reflects the changes.
- Report the live link after verification. If publishing fails, state what remains unpublished and why.

## Minimal UI by default

Build the smallest interface that fully supports the user's task. Every visible element must be explicitly requested or necessary for completing that task.

- Do not add hero sections, slogans, decorative headings, redundant labels, repeated instructions, counters, badges, feature summaries, or explanatory footers unless requested or functionally necessary.
- Give the primary workspace and controls the available screen space. Avoid large margins and introductory sections that crowd the actual tool.
- Keep instructions brief and show them once. Do not explain obvious controls.
- Show status messages when an action produces useful feedback or an error requires attention. Avoid permanent “ready,” privacy, or offline messages.
- Preserve accessibility through appropriate labels and semantics without adding redundant visible text.
- Before delivery, review every visible element: if removing it would preserve usability and requested functionality, remove it.

Treat restraint as a requirement. Do not add UI merely to make the app look more elaborate or “finished.”
