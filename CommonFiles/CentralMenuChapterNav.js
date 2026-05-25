// Collapsible chapter menus: hover on desktop; tap chapter title on touch.
(function () {
    document.addEventListener('DOMContentLoaded', function () {
        var chapters = document.querySelectorAll('.menuLists');
        if (!chapters.length) return;

        chapters.forEach(function (menu) {
            if (!menu.querySelector('.chapterDropdown')) {
                var items = Array.from(menu.querySelectorAll(':scope > li'));
                if (items.length) {
                    var panel = document.createElement('div');
                    panel.className = 'chapterDropdown';
                    items.forEach(function (li) { panel.appendChild(li); });
                    var header = menu.querySelector('h1');
                    if (header) {
                        header.insertAdjacentElement('afterend', panel);
                    } else {
                        menu.appendChild(panel);
                    }
                }
            }
        });

        var touchMode = window.matchMedia('(hover: none)').matches;

        chapters.forEach(function (menu) {
            var header = menu.querySelector('h1');
            if (!header) return;

            header.setAttribute('tabindex', '0');

            if (touchMode) {
                header.addEventListener('click', function (e) {
                    e.preventDefault();
                    var wasOpen = menu.classList.contains('is-open');
                    chapters.forEach(function (m) { m.classList.remove('is-open'); });
                    if (!wasOpen) menu.classList.add('is-open');
                });
            }
        });

        document.addEventListener('click', function (e) {
            if (!e.target.closest('.menuLists')) {
                chapters.forEach(function (m) { m.classList.remove('is-open'); });
            }
        });
    });
})();
