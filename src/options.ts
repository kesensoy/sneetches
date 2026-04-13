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

document.addEventListener('DOMContentLoaded', restoreOptions);

export function addInputEventListeners() {
  document.querySelectorAll('input').forEach((elt) => elt.addEventListener('change', saveOptions));
}

addInputEventListeners();
