/**
 * Toggle visibility of #footerLoginLink (Central Menu) with Ctrl + ` (Backquote).
 * Single listener per window; uses .admin-hidden (see CentralMenu.css).
 */
(function () {
  if (typeof window === "undefined") return;
  if (window.__bioMeAdminAccessToggleBound) return;
  window.__bioMeAdminAccessToggleBound = true;

  window.addEventListener(
    "keydown",
    function (e) {
      if (!e.ctrlKey) return;
      if (e.code !== "Backquote" && e.key !== "`") return;
      if (e.repeat) return;
      e.preventDefault();
      var link = document.getElementById("footerLoginLink");
      if (!link) return;
      link.classList.toggle("admin-hidden");
    },
    true
  );
})();
