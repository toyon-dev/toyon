// Composer box ids. A worktree's box is its own id, which its archive keeps; the box that drafts a
// new worktree belongs to its repo and is never a row's.

const DRAFT_PREFIX = "draft:";

/** the box a repo's new-worktree draft is written in */
export const draftKey = (repoId: string) => DRAFT_PREFIX + repoId;

/** the repo whose new-worktree draft a box is, or null for a worktree's box */
export const draftRepoOf = (boxId: string): string | null =>
  boxId.startsWith(DRAFT_PREFIX) ? boxId.slice(DRAFT_PREFIX.length) : null;
