export const COMPOSER_MAX_VISIBLE_LINES = 3;

export function resizeComposerTextarea(textarea: HTMLTextAreaElement, measure: HTMLElement): void {
  const style = getComputedStyle(textarea);
  const lineHeight = parseFloat(style.lineHeight);
  const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const minHeight = Math.ceil(lineHeight + verticalPadding);
  const maxHeight = Math.ceil(lineHeight * COMPOSER_MAX_VISIBLE_LINES + verticalPadding);
  const contentHeight = measure.scrollHeight;
  textarea.style.height = `${Math.min(Math.max(contentHeight, minHeight), maxHeight)}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  if (contentHeight > maxHeight && textarea.selectionStart === textarea.value.length) {
    textarea.scrollTop = textarea.scrollHeight;
  }
}
