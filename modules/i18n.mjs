// Fills a page's texts from _locales. Elements name their message with
// data-i18n (text content), data-i18n-placeholder, data-i18n-title or data-i18n-aria-label.

const ATTRIBUTES = {
  "data-i18n-placeholder": "placeholder",
  "data-i18n-title": "title",
  "data-i18n-aria-label": "aria-label",
};

export function t(key, substitutions) {
  return messenger.i18n.getMessage(key, substitutions) || key;
}

export function localizeDocument(root = document) {
  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const [dataAttribute, attribute] of Object.entries(ATTRIBUTES)) {
    for (const element of root.querySelectorAll(`[${dataAttribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(dataAttribute)));
    }
  }
  document.documentElement.lang = messenger.i18n.getUILanguage();
}
