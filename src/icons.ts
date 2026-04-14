// src/icons.ts
//
// Inline Octicons SVG strings. Octicons is MIT-licensed
// (https://github.com/primer/octicons) — we embed the four icons we use
// rather than taking a dependency, since that's all we need and it avoids
// any build-system complexity.

const STAR_PATH =
  'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z';

const STAR_FILL_PATH =
  'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z';

const REPO_FORKED_PATH =
  'M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z';

const CLOCK_PATH =
  'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z';

function svg(path: string, className: string): string {
  const safeClass = className.replace(/[^\w\s-]/g, '');
  return `<svg class="${safeClass}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
}

export function starIcon(className = 'sneetch-icon', filled = false): string {
  return filled ? svg(STAR_FILL_PATH, className) : svg(STAR_PATH, className);
}

export function repoForkedIcon(className = 'sneetch-icon'): string {
  return svg(REPO_FORKED_PATH, className);
}

export function clockIcon(className = 'sneetch-icon'): string {
  return svg(CLOCK_PATH, className);
}

const ARCHIVE_PATH =
  'M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v2.5A1.75 1.75 0 0 1 14.25 6H14v7.25A2.75 2.75 0 0 1 11.25 16h-6.5A2.75 2.75 0 0 1 2 13.25V6h-.25A1.75 1.75 0 0 1 0 4.25ZM1.75 1.5a.25.25 0 0 0-.25.25v2.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-2.5a.25.25 0 0 0-.25-.25Zm1.75 11.75c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V6h-9ZM5.75 9a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5Z';

export function archiveIcon(className = 'sneetch-icon'): string {
  return svg(ARCHIVE_PATH, className);
}
