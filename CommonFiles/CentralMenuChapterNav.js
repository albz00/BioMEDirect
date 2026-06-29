// Central-menu chapter navigation.
//
// Desktop: hovering a section title shows that section's lessons as a wide panel
// anchored DIRECTLY to the bottom of its own title (no gap). Show/hide is handled
// purely in CSS (.centralMenu > div:hover .chapterDropdown) so there are no JS
// timers to race — and because CSS :hover stays set on the column while the pointer
// is over its panel (a DOM descendant), moving from the title down into the lessons
// can never "lose" the hover and close it.
//
// Touch: tap a title to toggle its section (.is-open).
//
// This script only (a) wraps loose <li> lessons into a .chapterDropdown panel,
// (b) fills each panel's header (.cd-head) with the section title, and (c) sizes/
// positions each panel against the menu frame. Exposes window.BioMEChapterNav.init()
// / .layout() so it can re-run after ApplyMenuOverrides.js edits the menu.
(function () {
    var wiredOnce = false;            // page-level listeners wired only once
    var wiredMenus = new WeakSet();   // per-section listeners wired only once

    function touchMode() {
        return window.matchMedia && window.matchMedia('(hover: none)').matches;
    }

    function vminPx() {
        return Math.min(window.innerWidth, window.innerHeight) / 100;
    }

    function getCentral() {
        return document.querySelector('.centralMenu');
    }

    // Size/position every lessons panel so it sits flush under its OWN title (no gap,
    // so hover is never lost in between) and stretches down to near the frame bottom.
    function layoutPanels() {
        var central = getCentral();
        if (!central) return;
        var box = central.getBoundingClientRect();
        // Vertical extent comes from the menu FRAME, not .centralMenu (which only wraps
        // the title rows, since the panels are absolute and never stretch it).
        var frameEl = document.querySelector('.entireCentralMenu');
        var frameBox = frameEl ? frameEl.getBoundingClientRect() : box;
        var u = vminPx();
        var insetX = 2 * u;
        var insetBottom = 8 * u;       // leave room for the footer links below the menu
        var cardBottomVp = frameBox.bottom - insetBottom;
        var widthPx = Math.max(0, box.width - insetX * 2);

        central.querySelectorAll('.menuLists').forEach(function (menu) {
            var panel = menu.querySelector('.chapterDropdown');
            if (!panel) return;
            var h1 = menu.querySelector('h1');
            var titleBottomVp = h1 ? h1.getBoundingClientRect().bottom : box.top;

            // Overlap the title bottom by 1px so there is genuinely no dead gap.
            var topRel = (titleBottomVp - box.top) - 1;
            var height = Math.max(60, cardBottomVp - titleBottomVp);

            panel.style.position = 'absolute';
            panel.style.left = insetX + 'px';
            panel.style.right = 'auto';
            panel.style.top = topRel + 'px';
            panel.style.width = widthPx + 'px';
            panel.style.maxWidth = 'none';
            panel.style.height = height + 'px';
            panel.style.maxHeight = height + 'px';
        });
    }

    // Wrap loose <li>s into a panel, make sure the header slot exists, fill its text.
    function ensureStructure(menu) {
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
        var dropdown = menu.querySelector('.chapterDropdown');
        if (dropdown) {
            var head = dropdown.querySelector('.cd-head');
            if (!head) {
                head = document.createElement('div');
                head.className = 'cd-head';
                head.setAttribute('aria-hidden', 'true');
                dropdown.insertBefore(head, dropdown.firstChild);
            }
            var h1 = menu.querySelector('h1');
            head.textContent = h1 ? (h1.textContent || '').trim() : '';
        }
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

        // Touch: tap the title to toggle that section. (Desktop hover is pure CSS.)
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
                    layoutPanels();
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
            // Touch only: tap outside the menu closes any open section.
            if (touchMode()) {
                document.addEventListener('click', function (e) {
                    if (!e.target.closest('.menuLists')) closeAllTouch(central);
                });
            }
        }
    }

    window.BioMEChapterNav = { init: init, layout: layoutPanels };
    document.addEventListener('DOMContentLoaded', init);
})();
