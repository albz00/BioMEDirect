// Dynamically apply section and lesson name overrides from Firestore
// to the Central Menu pages (TextT and TextX).

// Assumes Firebase app has already been initialized on the page.

(function () {
    if (typeof firebase === 'undefined') {
        console.warn('Firebase not available for menu overrides.');
        return;
    }

    document.addEventListener('DOMContentLoaded', async () => {
        // Ensure a default app exists before trying to use Firestore
        let db;
        try {
            // Throws if no default app
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
                        headerEl: header
                    });
                }

                const buttons = sectionEl.querySelectorAll('button[onclick*="window.location.href"]');
                buttons.forEach(button => {
                    const onclick = button.getAttribute('onclick') || '';
                    const match = onclick.match(/window\.location\.href=['"]([^'"]+)['"]/);
                    if (!match) return;

                    // Use the original relative path exactly as declared in the onclick.
                    // CentralMenuT/X live under TextT/TextX, and the lesson paths are already
                    // correctly relative from there (e.g., 'LessonsT/...', 'LessonsX/...').
                    const path = match[1];

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
                console.log('[MenuOverrides] No sections or lessons detected in DOM.');
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
                    console.log('[MenuOverrides] Applying section override', sec.originalSection, '->', override);
                    sec.headerEl.textContent = override;
                }
            });

            // Load lesson display-name overrides (keyed by lessonId)
            const lessonMetaSnapshot = await db.collection('lessonMetadata').get();
            const lessonMetaById = {};
            lessonMetaSnapshot.forEach(doc => {
                lessonMetaById[doc.id] = doc.data() || {};
            });

            // Derive lessonId from path when fetch fails (matches convention: CamelCase + T -> snake_case + _t)
            function lessonIdFromPath(path) {
                const pathMatch = path.match(/([^/]+)\.html$/);
                if (!pathMatch) return null;
                let stem = pathMatch[1];
                if (!/T$/i.test(stem)) return null;
                stem = stem.replace(/T$/i, '');
                const parts = stem.split(/(?<=[a-z])(?=[A-Z])/).filter(Boolean);
                if (parts.length === 0) return null;
                return parts.join('_').toLowerCase().replace(/\s+/g, '_') + '_t';
            }

            // Helper to extract lessonId from a lesson HTML file
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

            // For each lesson button, resolve its lessonId and apply displayName override if present
            const resolvePromises = lessons.map(async lesson => {
                const lessonId = await fetchLessonIdForPath(lesson.path);
                if (!lessonId) return;
                const meta = lessonMetaById[lessonId];
                if (meta && meta.displayName) {
                    console.log('[MenuOverrides] Applying lesson override', lessonId, '->', meta.displayName);
                    lesson.buttonEl.textContent = meta.displayName;
                }
            });

            await Promise.all(resolvePromises);
        } catch (err) {
            console.error('Error applying menu overrides:', err);
        }
    });
})();

