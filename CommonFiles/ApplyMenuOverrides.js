// Dynamically apply section/lesson NAME overrides and the menu STRUCTURE overlay
// (reorder / hide / move / custom sections) from Firestore to the Central Menu
// pages (TextT and TextX). Structure is a non-destructive overlay on top of the
// hand-written HTML; one menuStructure/central doc drives both variants.

// Assumes Firebase app has already been initialized on the page.

(function () {
    if (typeof firebase === 'undefined') {
        console.warn('Firebase not available for menu overrides.');
        return;
    }

    // Variant-agnostic lesson key: lessonId with a trailing _t/_x removed.
    function baseLessonKey(lessonId) {
        return String(lessonId || '').replace(/_(t|x)$/i, '');
    }

    document.addEventListener('DOMContentLoaded', async () => {
        // Ensure a default app exists before trying to use Firestore
        let db;
        try {
            firebase.app();
            db = firebase.firestore ? firebase.firestore() : null;
        } catch (e) {
            console.warn('Firebase app not initialized for menu overrides.', e);
            return;
        }

        if (!db) {
            console.warn('Firestore not available for menu overrides.');
            return;
        }

        // Make sure dropdowns are wrapped before we move things around.
        if (window.BioMEChapterNav && typeof window.BioMEChapterNav.init === 'function') {
            window.BioMEChapterNav.init();
        }

        try {
            // Collect all sections and lesson entries from the current menu DOM
            const sectionLists = document.querySelectorAll('ul.menuLists');

            const sections = [];
            const lessons = [];

            console.log('[MenuOverrides] Initializing overrides...');

            sectionLists.forEach(sectionEl => {
                const header = sectionEl.querySelector('h1');
                const originalSection = header ? header.textContent.trim() : 'Uncategorized';

                if (header) {
                    sections.push({
                        originalSection,
                        headerEl: header,
                        sectionEl
                    });
                }

                const buttons = sectionEl.querySelectorAll('button[onclick*="window.location.href"]');
                buttons.forEach(button => {
                    const onclick = button.getAttribute('onclick') || '';
                    const match = onclick.match(/window\.location\.href=['"]([^'"]+)['"]/);
                    if (!match) return;

                    const path = match[1];
                    const originalName = button.textContent.trim();
                    lessons.push({
                        originalSection,
                        path,
                        originalName,
                        buttonEl: button,
                        liEl: button.closest('li'),
                        lessonId: null,
                        baseKey: null
                    });
                });
            });

            if (sections.length === 0 && lessons.length === 0) {
                console.log('[MenuOverrides] No sections or lessons detected in DOM.');
                return;
            }

            // ---- Display-name overrides (sections) ----
            const sectionSnapshot = await db.collection('sectionNames').get();
            const sectionOverrides = {};
            sectionSnapshot.forEach(doc => {
                const data = doc.data() || {};
                if (data.displayName) {
                    sectionOverrides[doc.id] = data.displayName;
                }
            });

            sections.forEach(sec => {
                const override = sectionOverrides[sec.originalSection];
                if (override) {
                    sec.headerEl.textContent = override;
                }
            });

            // ---- Display-name overrides (lessons), keyed by lessonId ----
            const lessonMetaSnapshot = await db.collection('lessonMetadata').get();
            const lessonMetaById = {};
            lessonMetaSnapshot.forEach(doc => {
                lessonMetaById[doc.id] = doc.data() || {};
            });

            function lessonIdFromPath(path) {
                const pathMatch = path.match(/([^/]+)\.html$/);
                if (!pathMatch) return null;
                let stem = pathMatch[1];
                if (!/[TX]$/i.test(stem)) return null;
                stem = stem.replace(/[TX]$/i, '');
                const parts = stem.split(/(?<=[a-z])(?=[A-Z])/).filter(Boolean);
                if (parts.length === 0) return null;
                const suffix = /X\.html$/i.test(path) ? '_x' : '_t';
                return parts.join('_').toLowerCase().replace(/\s+/g, '_') + suffix;
            }

            async function fetchLessonIdForPath(lessonPath) {
                try {
                    const response = await fetch(lessonPath);
                    if (!response.ok) return lessonIdFromPath(lessonPath);
                    const html = await response.text();
                    const match = html.match(/const\s+lessonId\s*=\s*["']([^"']+)["']/);
                    if (match) {
                        return match[1];
                    }
                    return lessonIdFromPath(lessonPath);
                } catch (e) {
                    console.warn('Failed to fetch lesson HTML for path', lessonPath, e);
                    return lessonIdFromPath(lessonPath);
                }
            }

            // Resolve each lesson's id + base key, and apply the name override.
            const resolvePromises = lessons.map(async lesson => {
                const lessonId = await fetchLessonIdForPath(lesson.path);
                lesson.lessonId = lessonId;
                lesson.baseKey = baseLessonKey(lessonId);
                if (!lessonId) return;
                const meta = lessonMetaById[lessonId];
                if (meta && meta.displayName) {
                    lesson.buttonEl.textContent = meta.displayName;
                }
            });

            await Promise.all(resolvePromises);

            // ---- Structure overlay (reorder / hide / move / custom sections) ----
            try {
                const structDoc = await db.collection('menuStructure').doc('central').get();
                if (structDoc.exists) {
                    applyStructure(structDoc.data() || {}, sections, lessons, sectionOverrides);
                }
            } catch (structErr) {
                console.warn('[MenuOverrides] Structure overlay skipped:', structErr);
            }

            // Re-wire any newly created sections (idempotent).
            if (window.BioMEChapterNav && typeof window.BioMEChapterNav.init === 'function') {
                window.BioMEChapterNav.init();
            }
        } catch (err) {
            console.error('Error applying menu overrides:', err);
        }
    });

    /**
     * Apply the menuStructure overlay to the live DOM.
     * structure.sections: [{ key, order, hidden, isCustom, displayName, lessons: [{ key, order, hidden }] }]
     */
    function applyStructure(structure, sections, lessons, sectionOverrides) {
        const centralMenu = document.querySelector('.centralMenu');
        if (!centralMenu || !structure || !Array.isArray(structure.sections)) return;

        // Maps from the live DOM
        const sectionElByKey = {};   // original section name -> ul.menuLists
        sections.forEach(s => { sectionElByKey[s.originalSection] = s.sectionEl; });

        const liByBaseKey = {};      // base lesson key -> <li>
        lessons.forEach(l => { if (l.baseKey && l.liEl) liByBaseKey[l.baseKey] = l.liEl; });

        // Column wrapper = direct child of .centralMenu that contains the ul.menuLists
        function columnOf(sectionEl) {
            let el = sectionEl;
            while (el && el.parentElement !== centralMenu) el = el.parentElement;
            return el || sectionEl;
        }
        function dropdownOf(sectionEl) {
            let panel = sectionEl.querySelector('.chapterDropdown');
            if (!panel) {
                panel = document.createElement('div');
                panel.className = 'chapterDropdown';
                const header = sectionEl.querySelector('h1');
                if (header) header.insertAdjacentElement('afterend', panel);
                else sectionEl.appendChild(panel);
            }
            return panel;
        }

        const orderedSections = structure.sections
            .slice()
            .sort((a, b) => (a.order || 0) - (b.order || 0));

        const visibleColumns = [];

        orderedSections.forEach(sec => {
            let sectionEl = sectionElByKey[sec.key];

            // Create a column for custom sections that don't exist in the HTML.
            if (!sectionEl && sec.isCustom) {
                if (sec.hidden) return;
                const wrapper = document.createElement('div');
                wrapper.className = 'group-custom';
                const ul = document.createElement('ul');
                ul.className = 'menuLists';
                const h1 = document.createElement('h1');
                h1.textContent = sec.displayName || sec.key;
                ul.appendChild(h1);
                const panel = document.createElement('div');
                panel.className = 'chapterDropdown';
                ul.appendChild(panel);
                wrapper.appendChild(ul);
                centralMenu.appendChild(wrapper);
                sectionEl = ul;
                sectionElByKey[sec.key] = ul;
            }

            if (!sectionEl) return; // orphan structure entry (HTML changed) -> skip

            const column = columnOf(sectionEl);

            if (sec.hidden) {
                column.style.display = 'none';
                return;
            }
            column.style.display = '';

            // Reorder lessons within the section; move lessons from other sections in.
            const panel = dropdownOf(sectionEl);
            const orderedLessons = (Array.isArray(sec.lessons) ? sec.lessons : [])
                .slice()
                .sort((a, b) => (a.order || 0) - (b.order || 0));

            orderedLessons.forEach(lessonEntry => {
                const li = liByBaseKey[lessonEntry.key];
                if (!li) return; // orphan lesson entry -> skip
                li.style.display = lessonEntry.hidden ? 'none' : '';
                panel.appendChild(li); // append in order (also moves between sections)
            });

            // Move the column to the end (sections processed in order -> final order)
            centralMenu.appendChild(column);
            visibleColumns.push(column);
        });

        // Edge alignment: leftmost dropdown opens left, rightmost opens right,
        // middle ones stay centered. These classes are defined in CentralMenu.css
        // and win over the static .group1/.group4 rules by source order.
        document.querySelectorAll('.menu-edge-left, .menu-edge-right').forEach(el => {
            el.classList.remove('menu-edge-left', 'menu-edge-right');
        });
        if (visibleColumns.length) {
            visibleColumns[0].classList.add('menu-edge-left');
            visibleColumns[visibleColumns.length - 1].classList.add('menu-edge-right');
        }
    }
})();
