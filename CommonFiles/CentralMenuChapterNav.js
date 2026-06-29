// Central-menu chapter navigation.
//
// On hover (desktop) or tap (touch) of a section title, that section's lessons
// open as a single panel that fills the menu box BELOW the title row, centered,
// laid out in multiple horizontal columns (so long lists never scroll and stay
// inside the box). The other section titles dim but remain hoverable so you can
// slide across to switch instantly.
//
// Exposes window.BioMEChapterNav.init() / .layout() so it can be re-run after the
// menu-structure overlay (ApplyMenuOverrides.js) adds or moves sections.
(function () {
    var wiredOnce = false;            // page-level listeners wired only once
    var wiredMenus = new WeakSet();   // per-section listeners wired only once
    var closeTimer = null;
    var CLOSE_DELAY = 180;            // ms grace so moving title -> panel doesn't close

    function touchMode() {
        return window.matchMedia && window.matchMedia('(hover: none)').matches;
    }

    function vminPx() {
        return Math.min(window.innerWidth, window.innerHeight) / 100;
    }

    function getCentral() {
        return document.querySelector('.centralMenu');
    }

    // Position every lessons panel to fill the box below the (bottom-most) title row.
    // Coordinates are relative to .centralMenu (the panel's containing block, since
    // .centralMenu is positioned and its column wrappers are static).
    function layoutPanels() {
        var central = getCentral();
        if (!central) return;
        var box = central.getBoundingClientRect();
        var u = vminPx();
        var insetX = 2 * u;
        var insetBottom = 2.5 * u;
        var gapTop = 1.4 * u;

        // Bottom-most title across all sections (handles title rows that wrap).
        var titlesBottomVp = box.top;
        central.querySelectorAll('.menuLists > h1').forEach(function (h) {
            var r = h.getBoundingClientRect();
            if (r.bottom > titlesBottomVp) titlesBottomVp = r.bottom;
        });

        var topRel = (titlesBottomVp - box.top) + gapTop;
        var leftRel = insetX;
        var width = Math.max(0, box.width - insetX * 2);
        var height = Math.max(0, box.height - insetBottom - topRel);

        central.querySelectorAll('.menuLists .chapterDropdown').forEach(function (panel) {
            panel.style.position = 'absolute';
            panel.style.left = leftRel + 'px';
            panel.style.right = 'auto';
            panel.style.top = topRel + 'px';
            panel.style.width = width + 'px';
            panel.style.maxWidth = 'none';
            // Width makes the row-wrap fit inside the box; height lets the centered
            // rows sit vertically centered in the area below the titles.
            panel.style.height = height + 'px';
            panel.style.maxHeight = height + 'px';
        });
    }

    function openMenu(menu) {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        var central = getCentral();
        if (!central) return;
        central.querySelectorAll('.menuLists.is-open').forEach(function (m) {
            if (m !== menu) m.classList.remove('is-open');
        });
        menu.classList.add('is-open');
        central.classList.add('menu-active');
        layoutPanels();
    }

    function closeAll() {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        var central = getCentral();
        if (!central) return;
        central.querySelectorAll('.menuLists.is-open').forEach(function (m) {
            m.classList.remove('is-open');
        });
        central.classList.remove('menu-active');
    }

    function scheduleClose() {
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(closeAll, CLOSE_DELAY);
    }

    function wireMenu(menu) {
        if (wiredMenus.has(menu)) return;
        wiredMenus.add(menu);

        var header = menu.querySelector('h1');
        if (header) header.setAttribute('tabindex', '0');

        if (touchMode()) {
            // Touch: tap the title to toggle that section.
            if (header) {
                header.addEventListener('click', function (e) {
                    e.preventDefault();
                    if (menu.classList.contains('is-open')) closeAll();
                    else openMenu(menu);
                });
            }
        } else {
            // Desktop: hover to open; small delay on leave so the gap between the
            // title and the panel doesn't close it. The panel is a DOM child of the
            // section, so moving onto it re-enters and cancels the close.
            menu.addEventListener('mouseenter', function () { openMenu(menu); });
            menu.addEventListener('mouseleave', function () { scheduleClose(); });
            // Keyboard: open on focus, close shortly after focus leaves the section.
            menu.addEventListener('focusin', function () { openMenu(menu); });
            menu.addEventListener('focusout', function () { scheduleClose(); });
        }
    }

    function init() {
        var central = getCentral();
        if (!central) return;
        var menus = central.querySelectorAll('.menuLists');
        if (!menus.length) return;

        // Wrap any loose <li> lesson items into a .chapterDropdown panel (idempotent).
        menus.forEach(function (menu) {
            if (!menu.querySelector('.chapterDropdown')) {
                var items = Array.prototype.slice.call(menu.querySelectorAll(':scope > li'));
                if (items.length) {
                    var panel = document.createElement('div');
                    panel.className = 'chapterDropdown';
                    items.forEach(function (li) { panel.appendChild(li); });
                    var header = menu.querySelector('h1');
                    if (header) header.insertAdjacentElement('afterend', panel);
                    else menu.appendChild(panel);
                }
            }
            wireMenu(menu);
        });

        layoutPanels();

        if (!wiredOnce) {
            wiredOnce = true;
            window.addEventListener('resize', layoutPanels);
            window.addEventListener('orientationchange', layoutPanels);
            // The rounded web font loads async and changes title sizes — re-measure.
            if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(layoutPanels).catch(function () {});
            }
            if ('ResizeObserver' in window) {
                try { new ResizeObserver(layoutPanels).observe(central); } catch (e) {}
            }
            // Click/tap outside the menu closes any open section.
            document.addEventListener('click', function (e) {
                if (!e.target.closest('.menuLists')) closeAll();
            });
        }
    }

    window.BioMEChapterNav = { init: init, layout: layoutPanels };
    document.addEventListener('DOMContentLoaded', init);
})();
