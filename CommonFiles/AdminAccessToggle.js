/**
 * Toggle visibility of #footerLoginLink (Central Menu) with Ctrl/Cmd + ` (backtick).
 * Single listener per window; uses .admin-hidden (see CentralMenu.css).
 * Accepts Backquote and IntlBackslash (layout variants); ignores key repeat and typing in fields.
 */
(function () {
  if (typeof window === "undefined") return;
  if (window.__bioMeAdminAccessToggleBound) return;
  window.__bioMeAdminAccessToggleBound = true;

  function isTypingContext(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(
      "input, textarea, select, [contenteditable='true'], [contenteditable='']"
    );
  }

  function isBacktickKey(e) {
    if (e.code === "Backquote" || e.code === "IntlBackslash") return true;
    var k = e.key;
    return k === "`" || k === "¨" || k === "Dead";
  }

  window.addEventListener(
    "keydown",
    function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      if (!isBacktickKey(e)) return;
      if (e.repeat) return;
      if (isTypingContext(e.target)) return;
      e.preventDefault();
      var link = document.getElementById("footerLoginLink");
      if (!link) return;
      link.classList.toggle("admin-hidden");
    },
    true
  );
})();
