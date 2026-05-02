/* ═══════════════════════════════════════════════════════
   YABBY — Internationalization (i18n) Module
   ═══════════════════════════════════════════════════════
   Lightweight translation system. Loads JSON locale files
   from /locales/{lang}.json. Components call t('key') to
   get translated strings.

   Usage:
     import { t, setLocale, getLocale, onLocaleChange } from './i18n.js';
     await setLocale('en');
     t('sidebar.dashboard')  // → "Dashboard"
     t('tasks.count', { n: 5 })  // → "5 tasks"
*/

let currentLocale = 'fr';
let strings = {};
let fallbackStrings = {};
const listeners = [];
const SUPPORTED_LOCALES = new Set(['fr', 'en', 'es', 'de']);

function normalizeLocale(lang) {
  if (!lang || typeof lang !== 'string') return 'fr';
  const normalized = lang.toLowerCase().split('-')[0];
  return SUPPORTED_LOCALES.has(normalized) ? normalized : 'fr';
}

/** Get a nested value from an object by dot-separated key */
function resolve(obj, key) {
  return key.split('.').reduce((o, k) => o?.[k], obj);
}

/**
 * Translate a key, with optional interpolation.
 * t('tasks.count', { n: 5 }) replaces {{n}} with 5.
 * Falls back to: current locale → fallback (en) → raw key.
 */
export function t(key, params) {
  let val = resolve(strings, key) ?? resolve(fallbackStrings, key) ?? key;
  if (params && typeof val === 'string') {
    for (const [k, v] of Object.entries(params)) {
      val = val.replaceAll(`{{${k}}}`, v);
    }
  }
  return val;
}

/** Get the current locale code */
export function getLocale() {
  return currentLocale;
}

/**
 * Load and activate a locale.
 * Fetches /locales/{lang}.json, falls back to 'en' if not found.
 */
export async function setLocale(lang) {
  const normalizedLang = normalizeLocale(lang);

  try {
    const res = await fetch(`/locales/${normalizedLang}.json`);
    if (!res.ok) throw new Error(`Locale ${normalizedLang} not found`);
    strings = await res.json();
  } catch {
    strings = {};
  }

  // Always load English as fallback (unless already English)
  if (normalizedLang !== 'en' && Object.keys(fallbackStrings).length === 0) {
    try {
      const res = await fetch('/locales/en.json');
      if (res.ok) fallbackStrings = await res.json();
    } catch { /* fallback stays empty */ }
  }

  currentLocale = normalizedLang;
  document.documentElement.lang = normalizedLang;

  // Persist preference
  localStorage.setItem('yabby-locale', normalizedLang);

  // Apply translations to any static HTML carrying data-i18n attributes.
  // Lets us localize index.html (breadcrumbs, search placeholder, tooltips)
  // without rewriting it as JS templates. Scoped to text content + a few
  // common attributes (placeholder, title, aria-label).
  try { applyI18nAttrs(document); } catch { /* ignore */ }

  // Notify listeners
  for (const cb of listeners) {
    try { cb(normalizedLang); } catch { /* ignore */ }
  }
}

/**
 * Walk a DOM root and translate elements marked with i18n attributes.
 * - data-i18n="key"             → element.textContent = t(key)
 * - data-i18n-placeholder="key" → element.placeholder = t(key)
 * - data-i18n-title="key"       → element.title = t(key)
 * - data-i18n-aria-label="key"  → aria-label = t(key)
 */
export function applyI18nAttrs(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.getAttribute('data-i18n-title'));
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  }
}

/** Register a callback for locale changes */
export function onLocaleChange(callback) {
  listeners.push(callback);
  return () => {
    const idx = listeners.indexOf(callback);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

/**
 * Initialize i18n. Call once at app startup.
 * Reads locale from: config API → localStorage → default 'fr'.
 */
export async function initI18n(configLocale) {
  const lang = normalizeLocale(configLocale
    || localStorage.getItem('yabby-locale')
    || 'fr');
  await setLocale(lang);
}
