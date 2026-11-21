export function focusTappedLocationInput(event) {
  if (event.pointerType !== 'touch' || !event.isPrimary) return;
  const input = event.target.closest('label')?.control || event.target;
  if (input.tagName === 'INPUT' && input.ownerDocument.activeElement !== input) {
    // Request the native keyboard before WebKit's tap-to-focus scroll runs.
    // The default tap still places the caret and supports text selection.
    input.focus({ preventScroll: true });
  }
}
