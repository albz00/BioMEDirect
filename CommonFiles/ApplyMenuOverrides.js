// Dynamically apply section and lesson name overrides from Firestore
// to the Central Menu pages (TextT and TextX).

// Assumes Firebase app has already been initialized on the page.

(function () {
    if (typeof firebase === 'undefined') {
        console.warn('Firebase not available for menu overrides.');
        return;
    }

    // Initialize Firestore (compat)
    const db = firebase.firestore ? firebase.firestore() : null;
    if (!db) {
        console.warn('Firestore not available for menu overrides.');
        return;
    }

    document.addEventListener('DOMContentLoaded', async () => {
        try {
            // Collect all sections and lesson entries from the current menu DOM
            const sectionLists = document.querySelectorAll('ul.menuLists');

            const sections = [];
            const lessons = [];

            sectionLists.forEach(sectionEl => {
                const header = sectionEl.querySelector('h1');
                const originalSection = header ? header.textContent.trim() : 'Uncategorized';

                if (header) {
                    sections.push({
                        originalSection,
                        headerEl: header
                    });
                }

                const buttons = sectionEl.querySelectorAll('button[onclick*="window.location.href"]');
                buttons.forEach(button => {
                    const onclick = button.getAttribute('onclick') || '';
                    const match = onclick.match(/window\.location\.href=['"]([^'"]+)['"]/);
                    if (!match) return;

                    let path = match[1];
                    // Normalize to TextT or TextX root, depending on current folder
                    // CentralMenuT/X are in TextT/TextX respectively, so paths are relative.
                    if (!path.startsWith('TextT/') && !path.startsWith('TextX/')) {
                        // Prepend current folder (TextT or TextX)
                        const basePrefix = window.location.pathname.includes('/TextX/') ? 'TextX/' : 'TextT/';
                        path = basePrefix + path;
                    }

                    const originalName = button.textContent.trim();
                    lessons.push({
                        originalSection,
                        path,
                        originalName,
                        buttonEl: button
                    });
                });
            });

            if (sections.length === 0 && lessons.length === 0) {
                return;
            }

            // Load section display-name overrides
            const sectionSnapshot = await db.collection('sectionNames').get();
            const sectionOverrides = {};
            sectionSnapshot.forEach(doc => {
                const data = doc.data() || {};
                if (data.displayName) {
                    sectionOverrides[doc.id] = data.displayName;
                }
            });

            // Apply section overrides
            sections.forEach(sec => {
                const override = sectionOverrides[sec.originalSection];
                if (override) {
                    sec.headerEl.textContent = override;
                }
            });

            // Load lesson display-name overrides (keyed by lessonId)
            const lessonMetaSnapshot = await db.collection('lessonMetadata').get();
            const lessonMetaById = {};
            lessonMetaSnapshot.forEach(doc => {
                lessonMetaById[doc.id] = doc.data() || {};
            });

            // Helper to extract lessonId from a lesson HTML file
            async function fetchLessonIdForPath(lessonPath) {
                try {
                    const response = await fetch(lessonPath);
                    if (!response.ok) return null;
                    const html = await response.text();
                    const match = html.match(/const\s+lessonId\s*=\s*["']([^"']+)["']/);
                    if (match) {
                        return match[1];
                    }

                    // Fallback: derive from path name like .../MendelianGeneticsT.html -> mendeliangeneticst
                    const pathMatch = lessonPath.match(/([^/]+)T\.html$/);
                    if (pathMatch) {
                        return pathMatch[1].toLowerCase().replace(/\s+/g, '_');
                    }
                    return null;
                } catch (e) {
                    console.warn('Failed to fetch lesson HTML for path', lessonPath, e);
                    return null;
                }
            }

            // For each lesson button, resolve its lessonId and apply displayName override if present
            const resolvePromises = lessons.map(async lesson => {
                const lessonId = await fetchLessonIdForPath(lesson.path);
                if (!lessonId) return;
                const meta = lessonMetaById[lessonId];
                if (meta && meta.displayName) {
                    lesson.buttonEl.textContent = meta.displayName;
                }
            });

            await Promise.all(resolvePromises);
        } catch (err) {
            console.error('Error applying menu overrides:', err);
        }
    });
})();

