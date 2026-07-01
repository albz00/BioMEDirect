// Central-menu chapter navigation — clean rebuild.
//
// Model: hovering a section title drops its lessons in a dropdown directly beneath
// that title. Each dropdown is flush under its OWN title (contiguous, no gap), so
// show/hide is pure CSS (.centralMenu > div:hover .chapterDropdown). CSS :hover
// stays set on a column while the pointer is over its dropdown (a DOM descendant),
// so moving from the title into the lessons can never "lose" the hover — no timers,
// no flicker. Headings may wrap onto a second row without breaking any of this.
//
// This script only:
//   1. wraps each section's loose <li> lessons into a .chapterDropdown panel,
//   2. nudges edge dropdowns so they don't spill off the frame,
//   3. wires tap-to-toggle for touch devices.
//
// The HTML structure (.centralMenu > div > ul.menuLists > h1 + <li>…) is left intact
// so ApplyMenuOverrides.js (the Firestore menu overlay) keeps working. Exposes
// window.BioMEChapterNav.init() / .layout().
(function () {
    var wiredOnce = false;
    var wiredMenus = new WeakSet();

    function touchMode() {
        return window.matchMedia && window.matchMedia('(hover: none)').matches;
    }
    function vminPx() {
        return Math.min(window.innerWidth, window.innerHeight) / 100;
    }
    function getCentral() {
        return document.querySelector('.centralMenu');
    }

    // Wrap a section's loose <li> lessons into a .chapterDropdown panel (idempotent).
    function ensureStructure(menu) {
        if (menu.querySelector('.chapterDropdown')) return;
        var items = Array.prototype.slice.call(menu.querySelectorAll(':scope > li'));
        if (!items.length) return;
        var panel = document.createElement('div');
        panel.className = 'chapterDropdown';
        items.forEach(function (li) { panel.appendChild(li); });
        var header = menu.querySelector('h1');
        if (header) header.insertAdjacentElement('afterend', panel);
        else menu.appendChild(panel);
    }

    // Keep each dropdown inside the frame: centered under its title by CSS, so an edge
    // title can overflow — nudge it back horizontally with margin.
    function clampDropdowns() {
        var central = getCentral();
        if (!central) return;
        var frameEl = document.querySelector('.entireCentralMenu');
        var frameBox = frameEl ? frameEl.getBoundingClientRect() : central.getBoundingClientRect();
        var margin = 2 * vminPx();
        var leftLimit = frameBox.left + margin;
        var rightLimit = frameBox.right - margin;
        central.querySelectorAll('.chapterDropdown').forEach(function (panel) {
            panel.style.marginLeft = '0px';
            var r = panel.getBoundingClientRect();
            var shift = 0;
            if (r.left < leftLimit) shift = leftLimit - r.left;
            else if (r.right > rightLimit) shift = rightLimit - r.right;
            if (shift) panel.style.marginLeft = Math.round(shift) + 'px';
        });
    }

    function relayout() {
        clampDropdowns();
    }

    function closeAllTouch(central) {
        central.querySelectorAll('.menuLists.is-open').forEach(function (m) {
            m.classList.remove('is-open');
        });
        central.classList.remove('menu-active');
    }

    function wireMenu(menu) {
        if (wiredMenus.has(menu)) return;
        wiredMenus.add(menu);
        var header = menu.querySelector('h1');
        if (header) header.setAttribute('tabindex', '0');

        // Touch: tap the title to toggle its section. (Desktop uses pure CSS hover.)
        if (touchMode() && header) {
            header.addEventListener('click', function (e) {
                e.preventDefault();
                var central = getCentral();
                if (!central) return;
                var wasOpen = menu.classList.contains('is-open');
                closeAllTouch(central);
                if (!wasOpen) {
                    menu.classList.add('is-open');
                    central.classList.add('menu-active');
                    clampDropdowns();
                }
            });
        }
    }

    function init() {
        var central = getCentral();
        if (!central) return;
        var menus = central.querySelectorAll('.menuLists');
        if (!menus.length) return;

        menus.forEach(function (menu) {
            ensureStructure(menu);
            wireMenu(menu);
        });

        relayout();

        if (!wiredOnce) {
            wiredOnce = true;
            window.addEventListener('resize', relayout);
            window.addEventListener('orientationchange', relayout);
            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(relayout).catch(function () {});
            }
            if ('ResizeObserver' in window) {
                try { new ResizeObserver(relayout).observe(central); } catch (e) {}
            }
            if (touchMode()) {
                document.addEventListener('click', function (e) {
                    if (!e.target.closest('.menuLists')) closeAllTouch(central);
                });
            }
        }
    }

    window.BioMEChapterNav = { init: init, layout: relayout };
    document.addEventListener('DOMContentLoaded', init);
})();
