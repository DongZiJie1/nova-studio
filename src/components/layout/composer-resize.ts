export const COMPOSER_MAX_TEXTAREA_HEIGHT = 148;

export function resizeComposerTextarea(textarea: HTMLTextAreaElement, measure: HTMLElement): void {
  const contentHeight = measure.scrollHeight;
  textarea.style.height = `${Math.min(Math.max(contentHeight, 78), COMPOSER_MAX_TEXTAREA_HEIGHT)}px`;
  textarea.style.overflowY = contentHeight > COMPOSER_MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  if (contentHeight > COMPOSER_MAX_TEXTAREA_HEIGHT && textarea.selectionStart === textarea.value.length) {
    textarea.scrollTop = textarea.scrollHeight;
  }
}
