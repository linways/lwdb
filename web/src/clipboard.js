// Copy text to the clipboard, returning whether it ACTUALLY succeeded.
//
// navigator.clipboard is unavailable in the desktop webview (WebKitGTK serving
// http://127.0.0.1 — the same non-injected context where Tauri's JS APIs are
// unreachable), where `navigator.clipboard?.writeText()` silently no-op'd while
// callers still toasted "Copied". We use the async API when it's really there
// and otherwise fall back to a hidden textarea + execCommand('copy'), which
// works synchronously inside a user gesture and needs no secure context.
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) { /* fall through to the execCommand path */ }
  }
  return legacyCopy(text);
}

// ponytail: execCommand('copy') is deprecated but it's the only thing that
// works in this webview; drop it once navigator.clipboard is reachable here.
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}
