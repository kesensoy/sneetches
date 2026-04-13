import { validateAccessToken, getStoredRateLimit, RateLimitInfo } from './github';
import { clearCache, getCacheEntryCount } from './cache';
import {
  ACCESS_TOKEN_KEY,
  ADVANCED_OPEN_KEY,
  DefaultAdvancedOpen,
  DefaultHasStarred,
  DefaultShowSettings,
  DefaultStarStyle,
  DefaultTokenValidated,
  DefaultToolbarIcon,
  HAS_STARRED_KEY,
  SHOW_KEY,
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
      const pct = (rl.remaining / rl.limit) * 100;
      rlBar.style.width = `${pct.toFixed(2)}%`;
    } else {
      rlValue.textContent = '— / — per hour';
      rlBar.style.width = '0%';
    }
  }

  let count = 0;
  try {
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

      // Restore Test button state based on persisted token_validated flag
      const testBtn = document.getElementById('token-test');
      if (testBtn && tokenValidated) {
        testBtn.textContent = '✓ Valid';
        testBtn.className = 'btn btn--ok';
      }

      updateTokenHelpVisibility(tokenValidated);
      applyStarredState(hasStarred);
      inputElement('show-forks').checked = show.forks;
      inputElement('show-stars').checked = show.stars;
      inputElement('show-update').checked = show.update;
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

export function addInputEventListeners() {
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
  const btn = document.getElementById('token-test');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const token = inputElement('access-token').value.trim();
    btn.textContent = 'Testing…';
    btn.className = 'btn';
    const result = await validateAccessToken(token);
    if (result.valid) {
      btn.textContent = '✓ Valid';
      btn.className = 'btn btn--ok';
      chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: true });
      updateTokenHelpVisibility(true);
    } else {
      btn.textContent = '✗ Invalid';
      btn.className = 'btn btn--err';
      chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: false });
      updateTokenHelpVisibility(false);
    }
  });

  // Reset to idle when the token is edited
  inputElement('access-token').addEventListener('input', () => {
    btn.textContent = 'Test';
    btn.className = 'btn btn--primary';
    chrome.storage.sync.set({ [TOKEN_VALIDATED_KEY]: false });
    updateTokenHelpVisibility(false);
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

function wireClearCache() {
  const btn = document.getElementById('clear-cache');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await clearCache();
    await refreshAdvancedStats();
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
  wireStarStylePreview();
  wireAdvancedToggle();
  wireClearCache();
  wireStarCtaEasterEgg();
  renderVersion();
});
