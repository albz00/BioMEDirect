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
    var openMenuEl = null;            // currently open section (for proximity close)
    var CLOSE_DELAY = 260;            // ms grace before an off-menu pointer closes
    var KEEP_MARGIN = 36;             // px slack around the menu/card that still counts as "inside"

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

        // Anchor the card just below the FIRST (top-most) title row so it sits high
        // in the box. If titles wrap onto extra rows, the card is allowed to cover
        // them — keeping the open card up near the cursor instead of way down.
        var titles = central.querySelectorAll('.menuLists > h1');
        var minTop = Infinity;
        var firstH = 0;
        titles.forEach(function (h) {
            var r = h.getBoundingClientRect();
            if (r.top < minTop) { minTop = r.top; firstH = r.height; }
        });
        var band = (minTop === Infinity ? box.top : minTop) + Math.max(firstH * 0.6, 6);
        var firstRowBottomVp = box.top;
        titles.forEach(function (h) {
            var r = h.getBoundingClientRect();
            if (r.top < band && r.bottom > firstRowBottomVp) firstRowBottomVp = r.bottom;
        });

        var topRel = (firstRowBottomVp - box.top) + gapTop;
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

    // Copy the section's title into its panel header so the hovered section's
    // title sits centered at the top of the open card (above its lessons).
    function syncPanelHeader(menu) {
        var head = menu.querySelector('.chapterDropdown .cd-head');
        var h1 = menu.querySelector('h1');
        if (head && h1) head.textContent = (h1.textContent || '').trim();
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
        openMenuEl = menu;
        syncPanelHeader(menu);
        layoutPanels();
    }

    function closeAll() {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        openMenuEl = null;
        var central = getCentral();
        if (!central) return;
        central.querySelectorAll('.menuLists.is-open').forEach(function (m) {
            m.classList.remove('is-open');
        });
        central.classList.remove('menu-active');
    }

    function pointNear(rect, x, y, m) {
        return rect && x >= rect.left - m && x <= rect.right + m &&
               y >= rect.top - m && y <= rect.bottom + m;
    }

    // While a section is open, keep it open as long as the pointer is anywhere near
    // the menu box OR the open lessons card (with slack). Only when it's clearly away
    // from both do we start the close timer. This survives gaps between the title and
    // its lessons, lessons that overflow the box edge, and quick diagonal moves.
    function onDocMove(e) {
        if (!openMenuEl) return;
        var central = getCentral();
        if (!central) return;
        var nearMenu = pointNear(central.getBoundingClientRect(), e.clientX, e.clientY, KEEP_MARGIN);
        var card = openMenuEl.querySelector('.chapterDropdown');
        var nearCard = card && pointNear(card.getBoundingClientRect(), e.clientX, e.clientY, KEEP_MARGIN);
        if (nearMenu || nearCard) {
            if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        } else {
            scheduleClose();
        }
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
            // Keyboard: open on focus, close shortly after focus leaves the section.
            // (Pointer open/close is handled at the .centralMenu level in init() so
            //  that gaps between a title and its card never bounce it closed.)
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
            // Ensure the panel has a header slot (filled with the section title on open).
            var dropdown = menu.querySelector('.chapterDropdown');
            if (dropdown && !dropdown.querySelector('.cd-head')) {
                var head = document.createElement('div');
                head.className = 'cd-head';
                head.setAttribute('aria-hidden', 'true');
                dropdown.insertBefore(head, dropdown.firstChild);
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

            // Whole-menu pointer handling. Opening/switching happens when the pointer
            // is over a section title; CLOSING is driven by onDocMove (proximity) so
            // the open card survives gaps, edge overflow, and diagonal moves.
            if (!touchMode()) {
                central.addEventListener('mouseover', function (e) {
                    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
                    // Over the open card (or anything inside it): just keep it open.
                    if (e.target.closest('.chapterDropdown')) return;
                    // Over a section title/column: make that section the open one
                    // (skip if it's already open to avoid needless re-layout churn).
                    var ml = e.target.closest('.menuLists');
                    if (ml && !ml.classList.contains('is-open')) openMenu(ml);
                    // Otherwise (gap/background inside the menu): keep current open.
                });
                document.addEventListener('mousemove', onDocMove);
            }

            // Click/tap outside the menu closes any open section.
            document.addEventListener('click', function (e) {
                if (!e.target.closest('.centralMenu')) closeAll();
            });
        }
    }

    window.BioMEChapterNav = { init: init, layout: layoutPanels };
    document.addEventListener('DOMContentLoaded', init);
})();
