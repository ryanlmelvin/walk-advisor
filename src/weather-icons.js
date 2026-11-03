// SPDX-License-Identifier: GPL-3.0-only
// Decorative glyphs accompany visible labels; they never imply sky conditions.
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

export const icons = Object.freeze({
  daylight: svg(`
    <g fill="none" stroke="#28543b" stroke-width="1.55" stroke-linecap="round">
      <path d="M12 2.6v2.1m0 14.6v2.1M2.6 12h2.1m14.6 0h2.1M5.3 5.3l1.5 1.5m10.4 10.4 1.5 1.5M5.3 18.7l1.5-1.5M17.2 6.8l1.5-1.5"/>
      <circle cx="12" cy="12" r="4.45" fill="#e8b54a"/>
    </g>`),
  afterDark: svg(`
    <path d="M15.7 3.5a8.7 8.7 0 1 0 4.8 12.6A7.7 7.7 0 0 1 15.7 3.5Z"
      fill="#e8b54a" stroke="#28543b" stroke-width="1.55" stroke-linejoin="round"/>`),
  precipitation: svg(`
    <path d="M6.3 14.7h10.5a3.7 3.7 0 0 0 .7-7.3 5.2 5.2 0 0 0-9.8-.8 4.1 4.1 0 0 0-1.4 8.1Z"
      fill="#e9efd9" stroke="#5e6d50" stroke-width="1.45" stroke-linejoin="round"/>
    <path d="m8 17.6-1.1 2.5m6.1-2.5-1.1 2.5m6.1-2.5-1.1 2.5"
      fill="none" stroke="#56817d" stroke-width="1.65" stroke-linecap="round"/>`),
});
