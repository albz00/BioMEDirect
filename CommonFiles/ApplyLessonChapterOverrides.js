// Apply chapter (menu button) display name overrides from Firestore to the lesson menu.
// Runs on lesson pages that have .lessonMenu and buttons with id="menu1", etc.
// Reads lessonMetadata/<lessonId>.chapterDisplayNames and updates button text.

(function () {
    if (typeof firebase === 'undefined') return;

    function lessonIdFromPath(pathOrFilename) {
        const pathMatch = pathOrFilename.match(/([^/]+)\.html$/);
        const stem = pathMatch ? pathMatch[1] : pathOrFilename;
        if (!/T$/i.test(stem)) return null;
        const withoutT = stem.replace(/T$/i, '');
        const parts = withoutT.split(/(?<=[a-z])(?=[A-Z])/).filter(Boolean);
        if (parts.length === 0) return null;
        return parts.join('_').toLowerCase().replace(/\s+/g, '_') + '_t';
    }

    document.addEventListener('DOMContentLoaded', async () => {
        const lessonMenu = document.querySelector('.lessonMenuPage .lessonMenu');
        const menuButtons = document.querySelectorAll('button[id^="menu"]');
        if (!lessonMenu || !menuButtons.length) return;

        let db;
        try {
            firebase.app();
            db = firebase.firestore ? firebase.firestore() : null;
        } catch (e) {
            return;
        }
        if (!db) return;

        const pathname = window.location.pathname || '';
        const lessonId = lessonIdFromPath(pathname);
        if (!lessonId) return;

        try {
            const metaDoc = await db.collection('lessonMetadata').doc(lessonId).get();
            const chapterDisplayNames = (metaDoc.exists && metaDoc.data().chapterDisplayNames)
                ? metaDoc.data().chapterDisplayNames
                : {};
            if (Object.keys(chapterDisplayNames).length === 0) return;

            menuButtons.forEach(button => {
                const menuId = button.getAttribute('id');
                if (menuId && chapterDisplayNames[menuId] !== undefined && chapterDisplayNames[menuId] !== null) {
                    button.textContent = chapterDisplayNames[menuId];
                }
            });
        } catch (err) {
            console.warn('[ApplyLessonChapterOverrides]', err);
        }
    });
})();
