import { CACHE_VERSION, validateAccessToken, getStoredRateLimit, RateLimitInfo } from './github';
import { clearCache, clearOwnerCache, getCacheEntryCount, sweepCache } from './cache';
import {
  ACCESS_TOKEN_KEY,
  ADVANCED_OPEN_KEY,
  DefaultAdvancedOpen,
  DefaultHasStarred,
  DefaultShowSettings,
  DefaultSkipOwners,
  DefaultStarStyle,
  DefaultTokenValidated,
  DefaultToolbarIcon,
  GITHUB_HANDLE_RE,
  HAS_STARRED_KEY,
  SHOW_KEY,
  SKIP_OWNERS_KEY,
  STAR_STYLE_KEY,
  TOKEN_VALIDATED_KEY,
  TOOLBAR_ICON_KEY,
  ToolbarIconMode,
} from './settings';

export function inputElement(id: string): HTMLInputElement {
  return document.querySelector('#' + id) as HTMLInputElement;
}

let savedIndicatorTimer: ReturnType<typeof setTimeout> | null = null;

function showSavedIndicator() {
  const indicator = document.getElementById('saved-indicator');
  if (!indicator) return;
  indicator.removeAttribute('hidden');
  if (savedIndicatorTimer !== null) clearTimeout(savedIndicatorTimer);
  savedIndicatorTimer = setTimeout(() => {
    indicator.setAttribute('hidden', '');
    savedIndicatorTimer = null;
  }, 1500);
}

function saveOptions() {
  // Trim the token on save so it matches what the Test button validates
  // (which also trims). Otherwise a trailing space on input would pass Test
  // but 401 on every real API call.
  chrome.storage.sync.set({
    [ACCESS_TOKEN_KEY]: inputElement('access-token').value.trim(),
    [SHOW_KEY]: {
      forks: inputElement('show-forks').checked,
      stars: inputElement('show-stars').checked,
      update: inputElement('show-update').checked,
      contributors: inputElement('show-contributors').checked,
    },
    [STAR_STYLE_KEY]: inputElement('ss-outline').checked ? 'outline' : 'filled',
  });
  showSavedIndicator();
}

async function refreshAdvancedStats() {
  let rl: RateLimitInfo | null = null;
  try {
    rl = await getStoredRateLimit();
  } catch {
    rl = null;
  }
  const rlValue = document.getElementById('rate-limit-value');
  const rlBar = document.getElementById('rate-limit-bar-fill') as HTMLElement | null;
  if (rlValue && rlBar) {
    if (rl) {
      rlValue.textContent = `${rl.remaining.toLocaleString()} / ${rl.limit.toLocaleString()} per hour`;
      // Guard against rl.limit === 0 (corrupted storage etc.) so the
      // width doesn't become "NaN%" — an invalid CSS value the browser
      // silently drops, leaving the bar at its previous width.
      const pct = rl.limit > 0 ? (rl.remaining / rl.limit) * 100 : 0;
      rlBar.style.width = `${pct.toFixed(2)}%`;
    } else {
      rlValue.textContent = '— / — per hour';
      rlBar.style.width = '0%';
    }
  }

  let count = 0;
  try {
    // Sweep before count so the displayed number reflects real live
    // entries — not expired / wrong-version cruft that readAllCachedRepos
    // would have filtered out anyway. Options page isn't covered by a
    // content-script preload (chrome-extension:// is outside our matches),
    // so this is the only time sweep runs for users who don't browse.
    await sweepCache(CACHE_VERSION);
    count = await getCacheEntryCount();
  } catch {
    count = 0;
  }
  const cacheCountEl = document.getElementById('cache-count');
  if (cacheCountEl) cacheCountEl.textContent = `${count} entries`;
}

function updateTokenHelpVisibility(validated: boolean) {
  const help = document.getElementById('token-help');
  if (!help) return;
  if (validated) {
    help.setAttribute('hidden', '');
  } else {
    help.removeAttribute('hidden');
  }
}

// Populate the collapsed row's token display: dimmed dots + last 4 chars
// (e.g. ••••••••493C). The last-4 tail matches GitHub's own tokens page
// convention so users can tell which stored token this is when they
// rotate between several. The prefix (ghp_ / github_pat_) is deliberately
// dropped — github_pat_ alone is 11 chars and visually dominated the
// 324px popup width without adding distinguishing value (the tail is
// already unique per token).
function populateCollapsedTokenDisplay() {
  const tokenEl = document.getElementById('token-collapsed-token');
  if (!tokenEl) return;
  // .trim() mirrors saveOptions/wireTokenTest — defends against any legacy
  // stored value with surrounding whitespace leaking into the tail display.
  const token = (
    (document.getElementById('access-token') as HTMLInputElement | null)?.value ?? ''
  ).trim();
  tokenEl.textContent = '';
  if (!token) return;
  const dotsSpan = document.createElement('span');
  dotsSpan.className = 'mute';
  dotsSpan.textContent = '••••••••';
  const tailSpan = document.createElement('span');
  tailSpan.textContent = token.slice(-4);
  tokenEl.append(dotsSpan, tailSpan);
}

// Toggle between the compact token-tail status row and the full input +
// Test button. Called from restoreOptions on load and from the Test
// button success path. Both elements stay in the DOM so the access-token
// input is always present for the existing input/eye/test handlers + tests.
// The section title is hidden in the collapsed state so the row actually
// reclaims vertical space.
function setTokenViewCollapsed(collapsed: boolean) {
  const collapsedEl = document.getElementById('token-collapsed');
  const expandedEl = document.getElementById('token-expanded');
  const titleEl = document.getElementById('token-section-title');
  if (!collapsedEl || !expandedEl) return;
  if (collapsed) {
    populateCollapsedTokenDisplay();
    collapsedEl.removeAttribute('hidden');
    expandedEl.setAttribute('hidden', '');
    titleEl?.setAttribute('hidden', '');
  } else {
    collapsedEl.setAttribute('hidden', '');
    expandedEl.removeAttribute('hidden');
    titleEl?.removeAttribute('hidden');
  }
}

function applyStarredState(isStarred: boolean) {
  const cta = document.querySelector('.star-cta');
  if (!cta) return;
  if (isStarred) {
    cta.classList.add('starred');
  } else {
    cta.classList.remove('starred');
  }
}

// Apply the toolbar icon for the current mode. chrome.action.setIcon is
// session-scoped, so this is called during restoreOptions on every popup
// or options-page open to re-sync the icon after browser restarts. The
// gray 32px is the manifest default; the 128px entry is kept colorful in
// both modes since it's only used for large surfaces like about:addons.
function applyToolbarIcon(mode: ToolbarIconMode) {
  // chrome.action is unavailable in test env / older contexts — skip silently.
  const action = (chrome as unknown as { action?: { setIcon?: (details: unknown) => void } })
    .action;
  if (!action?.setIcon) return;
  const path =
    mode === 'colorful'
      ? { 32: 'images/icon128.png', 128: 'images/icon128.png' }
      : { 32: 'images/icon32.png', 128: 'images/icon128.png' };
  action.setIcon({ path });
}

function restoreOptions() {
  chrome.storage.sync.get(
    [
      ACCESS_TOKEN_KEY,
      SHOW_KEY,
      STAR_STYLE_KEY,
      ADVANCED_OPEN_KEY,
      TOKEN_VALIDATED_KEY,
      HAS_STARRED_KEY,
      TOOLBAR_ICON_KEY,
    ],
    (items) => {
      const accessToken = items[ACCESS_TOKEN_KEY] as string | undefined;
      const show = { ...DefaultShowSettings, ...(items[SHOW_KEY] || {}) };
      const starStyle = items[STAR_STYLE_KEY] ?? DefaultStarStyle;
      const advancedOpen = items[ADVANCED_OPEN_KEY] ?? DefaultAdvancedOpen;
      const tokenValidated =
        (items[TOKEN_VALIDATED_KEY] as boolean | undefined) ?? DefaultTokenValidated;
      const hasStarred = (items[HAS_STARRED_KEY] as boolean | undefined) ?? DefaultHasStarred;
      const toolbarIcon =
        (items[TOOLBAR_ICON_KEY] as ToolbarIconMode | undefined) ?? DefaultToolbarIcon;

      // Re-sync toolbar icon after any browser restart (setIcon is session-scoped)
      applyToolbarIcon(toolbarIcon);

      inputElement('access-token').value = accessToken || '';

      // Restore Test button state based on persisted token_validated flag.
      // Also drive the collapsed/expanded view: validated + token-present →
      // compact status row; otherwise the full input + Test button.
      const testBtn = document.getElementById('token-test');
      if (testBtn && tokenValidated) {
        testBtn.textContent = '✓ Valid';
        testBtn.className = 'btn btn--ok';
      }
      setTokenViewCollapsed(Boolean(tokenValidated && accessToken));

      updateTokenHelpVisibility(tokenValidated);
      applyStarredState(hasStarred);
      inputElement('show-forks').checked = show.forks;
      inputElement('show-stars').checked = show.stars;
      inputElement('show-update').checked = show.update;
      inputElement('show-contributors').checked = show.contributors;
      inputElement('ss-outline').checked = starStyle === 'outline';
      inputElement('ss-fill').checked = starStyle === 'filled';

      // Apply body class for the live preview swap (CSS does the rest)
      document.body.classList.toggle('star-style--filled', starStyle === 'filled');

      // Apply advanced open/close state
      const advancedContent = document.getElementById('advanced-content');
      const advancedToggle = document.getElementById('advanced-toggle');
      const advancedSection = document.getElementById('advanced-section');
      if (advancedOpen) {
        advancedContent?.removeAttribute('hidden');
        advancedToggle?.setAttribute('aria-expanded', 'true');
        advancedSection?.setAttribute('data-open', 'true');
        refreshAdvancedStats();
      } else {
        advancedContent?.setAttribute('hidden', '');
        advancedToggle?.setAttribute('aria-expanded', 'false');
        advancedSection?.removeAttribute('data-open');
      }
    }
  );
}

function addInputEventListeners() {
  document.querySelectorAll('input').forEach((elt) => elt.addEventListener('change', saveOptions));
}

function wireTokenEye() {
  const eye = document.getElementById('token-eye');
  if (!eye) return;
  eye.addEventListener('click', (e) => {
    e.preventDefault();
    const input = inputElement('access-token');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}

function wireTokenTest() {
  const btn = document.getElementById('token-test') as HTMLButtonElement | null;
  if (!btn) return;
  // Reentrancy guard: rapid clicks while a validation is still in flight
  // would each fire their own validateAccessToken() call, wasting API
  // quota and racing on the subsequent chrome.storage.sync.set. Disable
  // the button for the duration and short-circuit stray handler calls
  // just in case the disabled attribute isn't honored somewhere.
  let validating = false;

  btn.addEventListener('click', async () => {
    if (validating) return;
    validating = true;
    btn.disabled = true;
    try {
      const token = inputElement('access-token').value.trim();
      btn.textContent = 'Testing…';
      btn.className = 'btn';
      const result = await validateAccessToken(token);
      if (result.valid) {
        btn.textContent = '✓ Valid';
        btn.className = 'btn btn--ok';
        chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: true });
        updateTokenHelpVisibility(true);
        setTokenViewCollapsed(true);
      } else {
        btn.textContent = '✗ Invalid';
        btn.className = 'btn btn--err';
        chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: false });
        updateTokenHelpVisibility(false);
      }
    } finally {
      validating = false;
      btn.disabled = false;
    }
  });

  // Reset to idle when the token is edited. Skip the storage write (and
  // the visual transition) if we're already in the idle state — typing a
  // 50-char PAT otherwise fires 50 redundant writes to chrome.storage.sync
  // and can hit the ~120-writes/minute sync rate limit. The idle state is
  // identified by the presence of the `btn--primary` modifier on the
  // button (the other states use `btn--ok`, `btn--err`, or bare `btn`).
  // classList.contains is preferred over a full className string match so
  // future additions like a transient `loading` class don't break the
  // check.
  inputElement('access-token').addEventListener('input', () => {
    if (btn.classList.contains('btn--primary')) return;
    btn.textContent = 'Test';
    btn.className = 'btn btn--primary';
    chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: false });
    updateTokenHelpVisibility(false);
  });
}

function wireTokenEdit() {
  const editBtn = document.getElementById('token-edit');
  if (!editBtn) return;
  editBtn.addEventListener('click', () => {
    setTokenViewCollapsed(false);
    updateTokenHelpVisibility(false);
    // Clicking "edit" is an explicit intent to change — reset the Test
    // button visual AND flip token_validated to false in storage so they
    // stay in sync. The in-memory button-state-as-proxy is load-bearing
    // for the input handler's de-dup guard (it short-circuits keystrokes
    // when the button is already primary); decoupling would let a user
    // type a new token mid-edit, close the popup, and have the next open
    // erroneously render the collapsed view with the unvalidated partial
    // token.
    const testBtn = document.getElementById('token-test');
    if (testBtn) {
      testBtn.textContent = 'Test';
      testBtn.className = 'btn btn--primary';
    }
    chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: false });
    // Focus the input so the user can immediately start typing a new value
    // without an extra click. Tests that don't render the full popup (e.g.
    // jsdom variants) still tolerate the focus call as a no-op.
    inputElement('access-token').focus();
  });
}

function wireStarStylePreview() {
  const sync = () => {
    document.body.classList.toggle('star-style--filled', inputElement('ss-fill').checked);
  };
  inputElement('ss-outline').addEventListener('change', sync);
  inputElement('ss-fill').addEventListener('change', sync);
}

function wireAdvancedToggle() {
  const toggle = document.getElementById('advanced-toggle');
  const content = document.getElementById('advanced-content');
  const section = document.getElementById('advanced-section');
  if (!toggle || !content || !section) return;

  toggle.addEventListener('click', () => {
    const isOpen = !content.hasAttribute('hidden');
    if (isOpen) {
      content.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      section.removeAttribute('data-open');
    } else {
      content.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      section.setAttribute('data-open', 'true');
      refreshAdvancedStats();
    }
    chrome.storage.sync.set({ [ADVANCED_OPEN_KEY]: !isOpen });
  });
}

function renderSkipOwnersList(owners: readonly string[]) {
  const listEl = document.getElementById('skip-owners-list');
  const countEl = document.getElementById('skip-owners-count');
  if (countEl) countEl.textContent = `${owners.length} owner${owners.length === 1 ? '' : 's'}`;
  if (!listEl) return;
  listEl.textContent = '';
  for (const owner of owners) {
    const row = document.createElement('div');
    row.className = 'skip-list-row';
    const name = document.createElement('span');
    name.textContent = owner;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link-btn link-btn--danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      void removeSkipOwner(owner);
    });
    row.append(name, remove);
    listEl.appendChild(row);
  }
}

// Rejects on chrome.runtime.lastError so callers don't confuse a transient
// sync-get failure with "empty list" and overwrite the real list on save.
function getStoredSkipOwners(): Promise<string[]> {
  return new Promise((resolve, reject) =>
    chrome.storage.sync.get([SKIP_OWNERS_KEY], (items) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      const raw = items[SKIP_OWNERS_KEY];
      resolve(Array.isArray(raw) ? (raw as string[]) : DefaultSkipOwners);
    })
  );
}

async function addSkipOwner(raw: string): Promise<'ok' | 'invalid' | 'duplicate' | 'error'> {
  const trimmed = raw.trim().toLowerCase();
  if (!GITHUB_HANDLE_RE.test(trimmed)) return 'invalid';
  let current: string[];
  try {
    current = await getStoredSkipOwners();
  } catch (err) {
    console.error('sneetches: skip_owners read failed, aborting add', err);
    return 'error';
  }
  if (current.includes(trimmed)) return 'duplicate';
  const next = [...current, trimmed].sort();
  await new Promise<void>((resolve) =>
    chrome.storage.sync.set({ [SKIP_OWNERS_KEY]: next }, () => resolve())
  );
  return 'ok';
}

async function removeSkipOwner(owner: string): Promise<void> {
  let current: string[];
  try {
    current = await getStoredSkipOwners();
  } catch (err) {
    console.error('sneetches: skip_owners read failed, aborting remove', err);
    return;
  }
  const next = current.filter((o) => o !== owner);
  if (next.length === current.length) return;
  await new Promise<void>((resolve) =>
    chrome.storage.sync.set({ [SKIP_OWNERS_KEY]: next }, () => resolve())
  );
  // Proactively drop the owner's cached 404s so broken chips reappear
  // immediately instead of waiting out the 4h TTL. Best-effort.
  try {
    await clearOwnerCache(owner);
  } catch (err) {
    console.error('sneetches: clearOwnerCache failed', err);
  }
}

function wireSkipOwners() {
  const toggle = document.getElementById('skip-owners-toggle');
  const panel = document.getElementById('skip-owners-panel');
  const input = document.getElementById('skip-owner-input') as HTMLInputElement | null;
  const addBtn = document.getElementById('skip-owner-add');
  if (!toggle || !panel || !input || !addBtn) return;

  toggle.addEventListener('click', () => {
    const open = !panel.hasAttribute('hidden');
    if (open) {
      panel.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'Manage';
    } else {
      panel.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.textContent = 'Hide';
      input.focus();
    }
  });

  const tryAdd = async () => {
    const value = input.value;
    if (!value.trim()) return;
    const result = await addSkipOwner(value);
    if (result === 'ok' || result === 'duplicate') {
      input.value = '';
      input.classList.remove('is-invalid');
    } else {
      input.classList.add('is-invalid');
    }
  };

  addBtn.addEventListener('click', () => {
    void tryAdd();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void tryAdd();
    }
  });
  input.addEventListener('input', () => input.classList.remove('is-invalid'));

  // Re-render on storage changes so cmd-click-driven additions from the
  // content script show up live, and removes from another popup instance
  // stay in sync.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !(SKIP_OWNERS_KEY in changes)) return;
    const next = changes[SKIP_OWNERS_KEY].newValue;
    renderSkipOwnersList(Array.isArray(next) ? (next as string[]) : []);
  });

  // Initial populate — best-effort; if the get fails the onChanged listener
  // above will still catch any subsequent updates.
  void getStoredSkipOwners()
    .then(renderSkipOwnersList)
    .catch((err) => console.error('sneetches: initial skip_owners load failed', err));
}

function wireClearCache() {
  const btn = document.getElementById('clear-cache');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    // clearCache talks to chrome.storage.local, which can reject on
    // quota/IO errors. Log and continue; the button click shouldn't
    // leave an unhandled promise rejection on the page.
    try {
      await clearCache();
      await refreshAdvancedStats();
    } catch (err) {
      console.error('sneetches: clear cache failed', err);
    }
  });
}

function renderVersion() {
  const versionEl = document.getElementById('version');
  if (!versionEl) return;
  // chrome.runtime.getManifest may not exist in test mocks, hence the optional chain
  const version = chrome.runtime?.getManifest?.()?.version ?? '';
  versionEl.textContent = version ? `Sneetches v${version}` : 'Sneetches';
}

// Easter egg: when the CTA is in the .starred state, each click spins the
// star and counts toward a 7-click combo that toggles the toolbar icon
// between the default gray star and the multicolor constellation. Suppresses
// navigation while .starred so every click feeds the counter instead of
// popping seven github.com tabs. The combo resets if clicks are separated
// by more than SPIN_RESET_MS.
const SPIN_COMBO_TARGET = 7;
const SPIN_RESET_MS = 2000;

function wireStarCtaEasterEgg() {
  const cta = document.querySelector('.star-cta') as HTMLAnchorElement | null;
  if (!cta) return;

  let clickCount = 0;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReset = () => {
    if (resetTimer !== null) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      clickCount = 0;
      resetTimer = null;
    }, SPIN_RESET_MS);
  };

  cta.addEventListener('click', (e) => {
    // Unstarred state keeps default navigation (the a[href] opens the repo).
    if (!cta.classList.contains('starred')) return;

    e.preventDefault();

    // Retrigger the spin on both icons (whichever is currently visible plays;
    // the hidden one just carries the class harmlessly). Toggling a class and
    // forcing a reflow is the canonical way to restart a CSS animation —
    // simply adding .spinning a second time is a no-op.
    //
    // IMPORTANT: the reflow must be read on an HTMLElement. SVGElement does
    // NOT expose offsetWidth, so `void svg.offsetWidth` is a no-op and the
    // browser coalesces the remove+add into a single style recalc that sees
    // no change. Reading offsetWidth on the anchor flushes pending style
    // changes for the whole subtree, including the SVG children.
    const icons = cta.querySelectorAll('.star-cta-icon');
    icons.forEach((el) => el.classList.remove('spinning'));
    void cta.offsetWidth;
    icons.forEach((el) => el.classList.add('spinning'));

    clickCount++;
    scheduleReset();

    if (clickCount >= SPIN_COMBO_TARGET) {
      clickCount = 0;
      if (resetTimer !== null) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
      chrome.storage.sync.get([TOOLBAR_ICON_KEY], (items) => {
        const current =
          (items[TOOLBAR_ICON_KEY] as ToolbarIconMode | undefined) ?? DefaultToolbarIcon;
        const next: ToolbarIconMode = current === 'colorful' ? 'gray' : 'colorful';
        chrome.storage.sync.set({ [TOOLBAR_ICON_KEY]: next });
        applyToolbarIcon(next);
      });
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // Mark popup vs options-page context. Firefox's options_ui page renders inside
  // an iframe in about:addons (window.top !== window); Chrome's chrome://extensions
  // behaves the same. The toolbar popup is always a top-level window in both.
  // The class scopes a fixed width in popup.css so Firefox's popup doesn't stretch
  // to its default ~800px max — see popup.css body.is-popup rule.
  if (window.top === window) {
    document.body.classList.add('is-popup');
  }
  restoreOptions();
  addInputEventListeners();
  wireTokenEye();
  wireTokenTest();
  wireTokenEdit();
  wireStarStylePreview();
  wireAdvancedToggle();
  wireClearCache();
  wireSkipOwners();
  wireStarCtaEasterEgg();
  renderVersion();
});
