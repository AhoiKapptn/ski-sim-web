# Stash collision - recovered work for src/world/sky.js

`git stash` is stored in ONE ref shared by every worktree of a repo. Two agents
used `git stash push`/`pop` at the same time and the stack crossed (LIFO):
whoever popped got the other agent's entry.

The sky.js agent's uncommitted work landed in the cloth agent's worktree
(.claude/worktrees/wf_7d30cff3-89c-5) and is preserved here:

- sky.js        - the full modified file as it was popped
- sky.js.patch  - git diff of it against HEAD (443 lines)

To restore it in the sky worktree:

    git apply /Users/philippbaldauf/Projects/private/ski-sim/.staging7/_stash-collision-recovery/sky.js.patch

or just copy sky.js over src/world/sky.js.

The cloth agent's own src/player/skier.js may symmetrically have landed in the
sky agent's worktree; the authoritative copy is
.staging7/cloth/src/player/skier.js

Nobody should use `git stash` in these worktrees.
