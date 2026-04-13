import { validateAccessToken } from './github';
import {
  ACCESS_TOKEN_KEY,
  ADVANCED_OPEN_KEY,
  DefaultAdvancedOpen,
  DefaultShowSettings,
  DefaultStarStyle,
  SHOW_KEY,
  STAR_STYLE_KEY,
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
  chrome.storage.sync.set({
    access_token: inputElement('access-token').value,
    show: {
      forks: inputElement('show-forks').checked,
      stars: inputElement('show-stars').checked,
      update: inputElement('show-update').checked,
    },
    star_style: inputElement('ss-outline').checked ? 'outline' : 'filled',
  });
  showSavedIndicator();
}

function restoreOptions() {
  chrome.storage.sync.get(
    [ACCESS_TOKEN_KEY, SHOW_KEY, STAR_STYLE_KEY, ADVANCED_OPEN_KEY],
    (items) => {
      const accessToken = items[ACCESS_TOKEN_KEY] as string | undefined;
      const show = { ...DefaultShowSettings, ...(items[SHOW_KEY] || {}) };
      const starStyle = items[STAR_STYLE_KEY] ?? DefaultStarStyle;
      const advancedOpen = items[ADVANCED_OPEN_KEY] ?? DefaultAdvancedOpen;

      inputElement('access-token').value = accessToken || '';
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
    } else {
      btn.textContent = '✗ Invalid';
      btn.className = 'btn btn--err';
    }
  });

  // Reset to idle when the token is edited
  inputElement('access-token').addEventListener('input', () => {
    btn.textContent = 'Test';
    btn.className = 'btn btn--primary';
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
    }
    chrome.storage.sync.set({ advanced_open: !isOpen });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  addInputEventListeners();
  wireTokenEye();
  wireTokenTest();
  wireStarStylePreview();
  wireAdvancedToggle();
});
