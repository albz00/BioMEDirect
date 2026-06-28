// Initialize Firebase
const firebaseConfig = {
    apiKey: "AIzaSyB0KbGW-4znfF19ikrUahdCyd_bEungkH4",
    authDomain: "biome-865cc.firebaseapp.com",
    projectId: "biome-865cc",
    storageBucket: "biome-865cc.firebasestorage.app",
    messagingSenderId: "952652458408",
    appId: "1:952652458408:web:23e7f0689e9cf973be959d"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const storage = firebase.storage();
const auth = firebase.auth();
const functions = firebase.functions();

// State
let availableVideos = [];
let lessonsData = [];
let loginScreen, dashboardScreen, loginForm, refreshVideosBtn, statusText, loginError, videosList;
let uploadVideoBtn, uploadVideoInput;
let instructionsBtn, changelogBtn, instructionsModal, changelogModal;
let profileBtn, profileModal;
let searchInput, filterButtons;
let currentFilter = 'all';
let searchQuery = '';
let selectedLessonId = null;
let collapsedSections = new Set();
/** Current srcArray and lesson id for the Timeline editor (Save All writes to lessons.doc(currentSrcArrayLessonId)) */
let currentSrcArrayForEditor = [];
let currentSrcArrayLessonId = null;
/** Ordered display titles from lessonMetadata.chapterOrder (same order as backend chapter mapping). */
let currentChapterTitlesForEditor = [];
const DEFAULT_MARKER_MODEL_CONTEXT = {
    version: 'color-marker-v1',
    modelIntent: {
        yellow: { role: 'freeze_frame_primary', preserveExistingBehavior: true },
        green: { role: 'freeze_frame_and_menu_anchor', freezeBackupEnabled: true, aiTitleMappingSource: true },
        red: { role: 'loop_marker', fullLoopLogicImplemented: true, loopReturnTarget: 'previous_freeze_marker_content', breaksOnUserClick: true },
    },
    realWorldNotes: [
        'Source videos may use overlapping/inconsistent marker logic.',
        'Yellow and green are treated as dual freeze-frame paths.',
        'Red loops back to the previous freeze marker content until the user clicks.',
    ],
    samplePlaybackRequired: {
        needed: false,
        checklist: [
            'Show yellow markers in context.',
            'Show green markers in context.',
            'Show red markers in context.',
            'Show expected loop-break behavior after click.',
        ],
    },
};

/** Show loading state on a button (spinner, disabled). Pass the button element and true/false. */
function setButtonLoading(btn, loading) {
    if (!btn || typeof btn.classList === 'undefined') return;
    if (loading) {
        btn.classList.add('btn-loading');
        btn.disabled = true;
    } else {
        btn.classList.remove('btn-loading');
        btn.disabled = false;
    }
}

// Check authentication state on load and on changes (set up immediately)
auth.onAuthStateChanged((user) => {
    console.log('Auth state changed, user:', user ? user.email : 'null');
    
    // Wait for DOM if not ready yet
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            handleAuthStateChange(user);
        });
    } else {
        handleAuthStateChange(user);
    }
});

function handleAuthStateChange(user) {
    // Ensure DOM elements are available
    if (!loginScreen) {
        loginScreen = document.getElementById('loginScreen');
    }
    if (!dashboardScreen) {
        dashboardScreen = document.getElementById('dashboardScreen');
    }
    
    if (user) {
        console.log('User authenticated:', user.email);
        showDashboard();
    } else {
        console.log('User not authenticated');
        showLogin();
        // Clear any sensitive data when logged out
        lessonsData = [];
        availableVideos = [];
    }
}

// Wait for DOM to be ready for event listeners
document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    loginScreen = document.getElementById('loginScreen');
    dashboardScreen = document.getElementById('dashboardScreen');
    loginForm = document.getElementById('loginForm');
    profileBtn = document.getElementById('profileBtn');
    profileModal = document.getElementById('profileModal');
    instructionsBtn = document.getElementById('instructionsBtn');
    changelogBtn = document.getElementById('changelogBtn');
    refreshVideosBtn = document.getElementById('refreshVideosBtn');
    uploadVideoBtn = document.getElementById('uploadVideoBtn');
    uploadVideoInput = document.getElementById('uploadVideoInput');
    statusText = document.getElementById('statusText');
    loginError = document.getElementById('loginError');
    videosList = document.getElementById('videosList');
    instructionsModal = document.getElementById('instructionsModal');
    changelogModal = document.getElementById('changelogModal');
    searchInput = document.getElementById('searchInput');
    filterButtons = document.querySelectorAll('.filter-btn');

    // Load remembered credentials if available
    const rememberedEmail = localStorage.getItem('rememberedEmail');
    const rememberedPassword = localStorage.getItem('rememberedPassword');
    if (rememberedEmail && rememberedPassword) {
        const emailInput = document.getElementById('email');
        const passwordInput = document.getElementById('password');
        const rememberMeCheckbox = document.getElementById('rememberMe');
        if (emailInput) emailInput.value = rememberedEmail;
        if (passwordInput) passwordInput.value = rememberedPassword;
        if (rememberMeCheckbox) rememberMeCheckbox.checked = true;
    }

    // Setup event listeners
    setupEventListeners();
    
    // Check current auth state and update UI
    const currentUser = auth.currentUser;
    if (currentUser) {
        showDashboard();
        // Automatically scan lessons and videos on load for convenience
        refreshDashboard().catch((e) => console.error('Auto-refresh failed:', e));
    } else {
        showLogin();
    }
});

// Handle auth errors (e.g., token expiration)
auth.onIdTokenChanged((user) => {
    if (!user && auth.currentUser === null) {
        // Token expired or user was logged out
        console.log('Authentication token expired or user logged out');
        if (loginScreen && dashboardScreen) {
            showLogin();
        }
    }
});

// Setup event listeners
function setupEventListeners() {
    // Login
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (loginError) {
                loginError.textContent = '';
                loginError.style.display = 'none';
            }
            
            const emailInput = document.getElementById('email');
            const passwordInput = document.getElementById('password');
            
            if (!emailInput || !passwordInput) {
                console.error('Email or password input not found');
                return;
            }
            
            const email = emailInput.value.trim();
            const password = passwordInput.value;
            const rememberMe = document.getElementById('rememberMe').checked;
            
            if (!email || !password) {
                showError('Please enter both email and password.');
                return;
            }
            
            try {
                console.log('Attempting login for:', email);
                const userCredential = await auth.signInWithEmailAndPassword(email, password);
                console.log('Login successful:', userCredential.user.email);
                
                // Save credentials if "Remember Me" is checked
                if (rememberMe) {
                    localStorage.setItem('rememberedEmail', email);
                    localStorage.setItem('rememberedPassword', password);
                } else {
                    // Clear saved credentials if not checked
                    localStorage.removeItem('rememberedEmail');
                    localStorage.removeItem('rememberedPassword');
                }
                
                // Login successful - onAuthStateChanged will handle navigation
            } catch (error) {
                console.error('Login error:', error);
                let errorMessage = 'Login failed. Please check your credentials.';
                
                // Provide more specific error messages
                if (error.code === 'auth/user-not-found') {
                    errorMessage = 'No account found with this email.';
                } else if (error.code === 'auth/wrong-password') {
                    errorMessage = 'Incorrect password.';
                } else if (error.code === 'auth/invalid-email') {
                    errorMessage = 'Invalid email address.';
                } else if (error.code === 'auth/user-disabled') {
                    errorMessage = 'This account has been disabled.';
                } else if (error.code === 'auth/too-many-requests') {
                    errorMessage = 'Too many failed login attempts. Please try again later.';
                } else if (error.code === 'auth/network-request-failed') {
                    errorMessage = 'Network error. Please check your connection.';
                } else if (error.message) {
                    errorMessage = error.message;
                }
                
                showError(errorMessage);
            }
        });
    }

    // View Main Menu
    const viewMainMenuBtn = document.getElementById('viewMainMenuBtn');
    if (viewMainMenuBtn) {
        viewMainMenuBtn.addEventListener('click', () => {
            window.location.href = 'TextT/CentralMenuT.html';
        });
    }

    // Instructions / Changelog modals
    function openModal(modal) {
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
    }

    function closeModal(modal) {
        if (!modal) return;
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }

    if (instructionsBtn && instructionsModal) {
        instructionsBtn.addEventListener('click', () => openModal(instructionsModal));
    }

    function getInstructionsPlainText(container) {
        if (!container) return '';
        const parts = [];
        const sections = container.querySelectorAll('.inst-section');
        sections.forEach((sec) => {
            const h3 = sec.querySelector('h3');
            const title = h3 ? h3.innerText.trim() : '';
            if (title) parts.push(title);
            const lists = sec.querySelectorAll('ul, ol');
            lists.forEach((list) => {
                const isOrdered = list.tagName === 'OL';
                list.querySelectorAll('li').forEach((li, i) => {
                    const pre = isOrdered ? `${i + 1}. ` : '• ';
                    parts.push(pre + li.innerText.trim().replace(/\s+/g, ' '));
                });
            });
            const p = sec.querySelector('p');
            if (p) parts.push(p.innerText.trim().replace(/\s+/g, ' '));
            parts.push('');
        });
        return parts.join('\n').trim();
    }

    const instructionsPrintBtn = document.getElementById('instructionsPrintBtn');
    const instructionsCopyBtn = document.getElementById('instructionsCopyBtn');
    const instructionsContent = document.getElementById('instructionsContent');
    if (instructionsPrintBtn && instructionsModal) {
        instructionsPrintBtn.addEventListener('click', () => {
            if (!instructionsModal.classList.contains('hidden')) {
                window.print();
            }
        });
    }
    if (instructionsCopyBtn && instructionsContent) {
        instructionsCopyBtn.addEventListener('click', () => {
            const text = getInstructionsPlainText(instructionsContent);
            navigator.clipboard.writeText(text).then(() => {
                const label = instructionsCopyBtn.querySelector('.btn-label');
                if (label) {
                    const orig = label.textContent;
                    label.textContent = 'Copied!';
                    setTimeout(() => { label.textContent = orig; }, 1500);
                }
            }).catch(() => {});
        });
    }

    if (changelogBtn && changelogModal) {
        changelogBtn.addEventListener('click', () => openModal(changelogModal));
    }

    // Generic close handlers (backdrop or [data-close-modal] button)
    [instructionsModal, changelogModal, profileModal].forEach((modal) => {
        if (!modal) return;

        modal.addEventListener('click', (e) => {
            const target = e.target;
            if (target.hasAttribute && target.hasAttribute('data-close-modal')) {
                closeModal(modal);
            } else if (target.classList && target.classList.contains('modal-backdrop')) {
                closeModal(modal);
            }
        });
    });

    // Video preview modal close
    const videoPreviewModal = document.getElementById('videoPreviewModal');
    const videoPreviewClose = document.getElementById('videoPreviewClose');
    if (videoPreviewModal) {
        videoPreviewModal.addEventListener('click', (e) => {
            if (e.target === videoPreviewClose || e.target.classList.contains('video-preview-backdrop')) {
                closeVideoPreview();
            }
        });
        if (videoPreviewClose) {
            videoPreviewClose.addEventListener('click', closeVideoPreview);
        }
    }

    setupSrcArrayEditorListeners();

    // Profile button: open profile modal and fill with current user
    if (profileBtn && profileModal) {
        profileBtn.addEventListener('click', () => {
            const user = auth.currentUser;
            const emailEl = document.getElementById('profileEmail');
            const displayNameEl = document.getElementById('profileDisplayName');
            const uidEl = document.getElementById('profileUid');
            if (emailEl) emailEl.textContent = user ? user.email || '—' : '—';
            if (displayNameEl) displayNameEl.textContent = (user && user.displayName) ? user.displayName : '—';
            if (uidEl) uidEl.textContent = user ? user.uid : '—';
            openModal(profileModal);
        });
    }

    // Close modals with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            [instructionsModal, changelogModal, profileModal].forEach((modal) => {
                if (modal && !modal.classList.contains('hidden')) {
                    closeModal(modal);
                }
            });
            if (videoPreviewModal && !videoPreviewModal.classList.contains('hidden')) {
                closeVideoPreview();
            }
        }
    });

    // Logout (from profile modal)
    const profileLogoutBtn = document.getElementById('profileLogoutBtn');
    if (profileLogoutBtn) {
        profileLogoutBtn.addEventListener('click', async () => {
            try {
                await auth.signOut();
                console.log('User logged out successfully');
                if (profileModal) closeModal(profileModal);
                window.location.href = 'TextT/CentralMenuT.html';
            } catch (error) {
                console.error('Logout error:', error);
                alert('Error logging out: ' + error.message);
            }
        });
    }

    // Refresh dashboard (lessons + videos + panels)
    if (refreshVideosBtn) {
        refreshVideosBtn.addEventListener('click', async () => {
            await refreshDashboard();
        });
    }

    // Map Segment Links
    // Upload Videos
    if (uploadVideoBtn && uploadVideoInput) {
        uploadVideoBtn.addEventListener('click', () => {
            uploadVideoInput.click();
        });

        uploadVideoInput.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files || []).filter(f => f.type === 'video/mp4');
            if (!files.length) {
                return;
            }

            try {
                requireAuth();
            } catch {
                setStatus('Authentication required', 'error');
                return;
            }

            uploadVideoBtn.disabled = true;
            setStatus(`Uploading ${files.length} video${files.length > 1 ? 's' : ''}...`, 'scanning');

            try {
                const storageRef = storage.ref().child('videos');
                for (const file of files) {
                    const fileRef = storageRef.child(file.name);
                    const metadata = (files.length === 1 && selectedLessonId)
                        ? { customMetadata: { lessonId: selectedLessonId } }
                        : undefined;
                    await fileRef.put(file, metadata);
                }

                setStatus('Upload complete. Refreshing dashboard (timeline will update when Cloud Function runs)...', 'success');
                await loadAvailableVideos();
                // If a single file was uploaded and its name matches a lessonId, assign it so the lesson uses this video
                if (files.length === 1) {
                    const baseName = files[0].name.replace(/\.mp4$/i, '');
                    const lesson = lessonsData.find(l => l.lessonId === baseName);
                    if (lesson) {
                        const videoPath = `videos/${files[0].name}`;
                        await db.collection('videoPaths').doc(baseName).set({ videoPath }, { merge: true });
                    }
                }
                await refreshDashboard();
            } catch (error) {
                console.error('Error uploading videos:', error);
                setStatus('Error uploading videos: ' + error.message, 'error');
            } finally {
                uploadVideoBtn.disabled = false;
                uploadVideoInput.value = '';
                setTimeout(() => setStatus('Ready'), 3000);
            }
        });
    }

    // Search Input
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase().trim();
            renderSidebarTree();
            displaySelectedLesson();
        });
    }

    // Filter Buttons
    if (filterButtons) {
        filterButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                filterButtons.forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                currentFilter = e.target.getAttribute('data-filter');
                renderSidebarTree();
                displaySelectedLesson();
            });
        });
    }

    // Sidebar collapse toggle
    const sidebarToggle = document.getElementById('sidebarToggle');
    const lessonsSidebar = document.getElementById('lessonsSidebar');
    if (sidebarToggle && lessonsSidebar) {
        sidebarToggle.addEventListener('click', () => {
            lessonsSidebar.classList.toggle('collapsed');
            const useEl = document.getElementById('sidebarToggleIcon');
            if (useEl) useEl.setAttribute('href', lessonsSidebar.classList.contains('collapsed') ? '#icon-chevron-right' : '#icon-chevron-left');
            sidebarToggle.title = lessonsSidebar.classList.contains('collapsed') ? 'Expand sidebar' : 'Collapse sidebar';
            sidebarToggle.setAttribute('aria-label', lessonsSidebar.classList.contains('collapsed') ? 'Expand sidebar' : 'Collapse sidebar');
        });
    }

    // Tree section expand/collapse (delegated)
    const sidebarTree = document.getElementById('sidebarTree');
    if (sidebarTree) {
        sidebarTree.addEventListener('click', (e) => {
            const header = e.target.closest('.tree-section-header');
            if (!header) return;
            e.preventDefault();
            const sectionEl = header.closest('.tree-section');
            if (!sectionEl) return;
            const key = sectionEl.getAttribute('data-section');
            if (key) toggleSectionInSidebar(key);
        });
    }
}

// Show error message
function showError(message) {
    if (loginError) {
        loginError.textContent = message;
        loginError.style.display = 'block';
        loginError.style.visibility = 'visible';
        loginError.style.opacity = '1';
    } else {
        console.error('Error element not found:', message);
        alert(message);
    }
}

// Protect dashboard functions - ensure user is authenticated
function requireAuth() {
    const user = auth.currentUser;
    if (!user) {
        throw new Error('User must be authenticated');
    }
    return user;
}

// Functions
function showLogin() {
    if (!loginScreen || !dashboardScreen) {
        console.error('Screen elements not found');
        return;
    }
    console.log('Showing login screen');
    loginScreen.classList.remove('hidden');
    loginScreen.style.display = 'block';
    dashboardScreen.classList.add('hidden');
    dashboardScreen.style.display = 'none';
}

function showDashboard() {
    if (!loginScreen || !dashboardScreen) {
        console.error('Screen elements not found');
        return;
    }
    console.log('Showing dashboard');
    loginScreen.classList.add('hidden');
    loginScreen.style.display = 'none';
    dashboardScreen.classList.remove('hidden');
    dashboardScreen.style.display = 'block';
    
    // Only load videos if user is authenticated
    const user = auth.currentUser;
    if (user) {
        console.log('Loading videos for authenticated user');
        loadAvailableVideos();
    }
}

function setStatus(text, type = '') {
    statusText.textContent = text;
    statusText.parentElement.className = 'status-indicator' + (type ? ' ' + type : '');
}

async function loadAvailableVideos() {
    try {
        requireAuth(); // Ensure user is authenticated
    } catch (error) {
        setStatus('Authentication required', 'error');
        return;
    }
    
    setStatus('Loading available videos...', 'scanning');
    refreshVideosBtn.disabled = true;
    
    try {
        const videosRef = storage.ref().child('videos');
        const listResult = await videosRef.listAll();
        
        availableVideos = [];
        
        for (const itemRef of listResult.items) {
            const fileName = itemRef.name;
            if (fileName.endsWith('.mp4')) {
                availableVideos.push(fileName);
            }
        }
        
        availableVideos.sort();
        await displayAvailableVideos();
        setStatus(`Loaded ${availableVideos.length} videos`, 'success');
    } catch (error) {
        console.error('Error loading videos:', error);
        setStatus('Error loading videos: ' + error.message, 'error');
    } finally {
        refreshVideosBtn.disabled = false;
    }
}

function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
}

function formatDuration(seconds) {
    if (seconds == null || isNaN(seconds) || seconds < 0) return '—:—';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function getAssignedVideoCount() {
    if (!lessonsData.length || !availableVideos.length) return 0;
    const assignedFilenames = new Set();
    lessonsData.forEach(lesson => {
        const path = lesson.currentPath || '';
        const match = path.match(/videos\/([^/]+)$/);
        if (match) assignedFilenames.add(match[1]);
    });
    // Count how many of the *available* videos (in Storage) are tied to at least one lesson
    return availableVideos.filter((fileName) => assignedFilenames.has(fileName)).length;
}

function updateVideosCountDisplay() {
    const countEl = document.getElementById('videosCount');
    if (!countEl) return;
    const inUse = getAssignedVideoCount();
    countEl.textContent = `(${availableVideos.length} available · ${inUse} tied to lessons)`;
}

async function displayAvailableVideos() {
    const countEl = document.getElementById('videosCount');
    if (countEl) {
        updateVideosCountDisplay();
    }

    if (availableVideos.length === 0) {
        videosList.innerHTML = '<p class="placeholder">No videos found in Storage</p>';
        updateVideosCountDisplay();
        return;
    }

    videosList.innerHTML = availableVideos.map(video => {
        const esc = video.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        return `<div class="video-item" data-video="${esc}" title="Click to play">
            <div class="video-item-main">
                <span class="video-item-name">${esc}</span>
                <span class="video-item-meta"><span class="video-item-size" data-video="${esc}">—</span> · <span class="video-item-duration" data-video="${esc}">—:—</span></span>
            </div>
            <div class="video-item-actions">
                <button type="button" class="btn btn-secondary btn-ghost btn-sm video-item-preview" data-video="${esc}">
                    <span class="btn-label">Preview</span>
                </button>
                <button type="button" class="btn btn-secondary btn-sm video-item-delete" data-video="${esc}">
                    <span class="btn-label">Delete</span>
                </button>
            </div>
        </div>`;
    }).join('');

    // Preview click (video row, or Preview button)
    videosList.querySelectorAll('.video-item-preview').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const file = btn.getAttribute('data-video');
            openVideoPreview(file);
        });
    });

    // Delete click
    videosList.querySelectorAll('.video-item-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const file = btn.getAttribute('data-video');
            deleteVideo(file, btn);
        });
    });

    // Load size and duration for each video (size from Storage metadata, duration from video element)
    const BATCH = 4;
    for (let i = 0; i < availableVideos.length; i += BATCH) {
        const batch = availableVideos.slice(i, i + BATCH);
        await Promise.all(batch.map(async (fileName) => {
            const ref = storage.ref().child('videos/' + fileName);
            try {
                const meta = await ref.getMetadata();
                const sizeEl = videosList.querySelector(`.video-item-size[data-video="${CSS.escape(fileName)}"]`);
                if (sizeEl) sizeEl.textContent = formatBytes(meta.size);
            } catch (e) {
                const sizeEl = videosList.querySelector(`.video-item-size[data-video="${CSS.escape(fileName)}"]`);
                if (sizeEl) sizeEl.textContent = '—';
            }
        }));
    }

    for (let i = 0; i < availableVideos.length; i += BATCH) {
        const batch = availableVideos.slice(i, i + BATCH);
        await Promise.all(batch.map((fileName) => loadVideoDuration(fileName)));
    }
}

function loadVideoDuration(fileName) {
    return new Promise((resolve) => {
        const durationEl = videosList.querySelector(`.video-item-duration[data-video="${CSS.escape(fileName)}"]`);
        if (!durationEl) {
            resolve();
            return;
        }
        const ref = storage.ref().child('videos/' + fileName);
        ref.getDownloadURL()
            .then((url) => {
                const video = document.createElement('video');
                video.preload = 'metadata';
                const onDone = () => {
                    const d = video.duration;
                    if (durationEl) durationEl.textContent = formatDuration(d);
                    video.removeAttribute('src');
                    video.load();
                    resolve();
                };
                video.addEventListener('loadedmetadata', onDone, { once: true });
                video.addEventListener('error', () => {
                    if (durationEl) durationEl.textContent = '—:—';
                    resolve();
                }, { once: true });
                video.src = url;
            })
            .catch(() => {
                if (durationEl) durationEl.textContent = '—:—';
                resolve();
            });
    });
}

async function openVideoPreview(fileName) {
    if (!fileName) return;
    const modal = document.getElementById('videoPreviewModal');
    const titleEl = document.getElementById('videoPreviewTitle');
    const player = document.getElementById('videoPreviewPlayer');
    if (!modal || !player) return;
    titleEl.textContent = fileName;
    player.removeAttribute('src');
    player.load();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    try {
        const ref = storage.ref().child('videos/' + fileName);
        const url = await ref.getDownloadURL();
        player.src = url;
        // Do not autoplay; user can press play in the modal
    } catch (e) {
        console.error('Error loading video:', e);
        setStatus('Could not load video for preview', 'error');
    }
}

// Delete a video from Storage and its associated srcArray (lessons doc), then refresh lists
async function deleteVideo(fileName, btn) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }
    if (!fileName) return;

    const confirmed = window.confirm(`Delete video "${fileName}" from Storage and its srcArray? This cannot be undone.`);
    if (!confirmed) return;

    setButtonLoading(btn, true);
    setStatus(`Deleting video ${fileName}...`, 'scanning');

    try {
        const storageRef = storage.ref().child('videos/' + fileName);
        // Delete video file from Storage
        await storageRef.delete();

        // Delete srcArray document keyed by video filename (without extension)
        const baseMatch = fileName.match(/^(.+)\.mp4$/i);
        if (baseMatch) {
            const videoDocId = baseMatch[1];
            try {
                await db.collection('lessons').doc(videoDocId).delete();
            } catch (e) {
                // Ignore not-found
                console.warn('No srcArray doc to delete for', videoDocId, e);
            }
        }

        // Clear any lesson assignments that used this video
        const tasks = [];
        lessonsData.forEach(lesson => {
            if ((lesson.currentPath || '') === `videos/${fileName}`) {
                lesson.currentPath = '';
                lesson.hasVideo = false;
                tasks.push(
                    db.collection('videoPaths').doc(lesson.lessonId).set({
                        videoPath: firebase.firestore.FieldValue.delete()
                    }, { merge: true })
                );
            }
        });
        if (tasks.length) {
            await Promise.all(tasks);
        }

        // Remove from availableVideos and refresh UI
        availableVideos = availableVideos.filter(v => v !== fileName);
        await displayAvailableVideos();
        renderSidebarTree();
        displaySelectedLesson();
        refreshSrcArrayEditor();
        updateVideosCountDisplay();

        setStatus(`Deleted video ${fileName}`, 'success');
        setTimeout(() => setStatus('Ready'), 2500);
    } catch (error) {
        console.error('Error deleting video:', error);
        alert('Error deleting video: ' + error.message);
        setStatus('Error deleting video: ' + error.message, 'error');
    } finally {
        setButtonLoading(btn, false);
    }
}

function closeVideoPreview() {
    const modal = document.getElementById('videoPreviewModal');
    const player = document.getElementById('videoPreviewPlayer');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
    if (player) {
        player.pause();
        player.removeAttribute('src');
        player.load();
    }
}

// Parse central menu to extract section names, lesson paths and names
async function parseCentralMenu() {
    try {
        const response = await fetch('TextT/CentralMenuT.html');
        if (!response.ok) {
            throw new Error('Failed to fetch central menu');
        }
        const html = await response.text();
        
        // Parse HTML to extract lesson links
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const lessons = [];

        // Each section is represented by a UL with class menuLists that contains an H1 title
        const sectionLists = doc.querySelectorAll('ul.menuLists');
        sectionLists.forEach(sectionEl => {
            const header = sectionEl.querySelector('h1');
            const sectionName = header ? header.textContent.trim() : 'Uncategorized';

            const buttons = sectionEl.querySelectorAll('button[onclick*="window.location.href"]');
            buttons.forEach(button => {
                const onclick = button.getAttribute('onclick');
                const match = onclick && onclick.match(/window\.location\.href=['"]([^'"]+)['"]/);
                if (match) {
                    let path = match[1];
                    // Paths in menu are relative to TextT/, so prepend TextT/ if not already there
                    if (!path.startsWith('TextT/')) {
                        path = 'TextT/' + path;
                    }
                    const name = button.textContent.trim();
                    lessons.push({ path, name, section: sectionName });
                }
            });
        });
        
        return lessons;
    } catch (error) {
        console.error('Error parsing central menu:', error);
        throw error;
    }
}

// Derive lessonId from path when HTML fetch fails (matches convention: CamelCase + T -> snake_case + _t)
function lessonIdFromPath(lessonPath) {
    const pathMatch = lessonPath.match(/([^/]+)\.html$/);
    if (!pathMatch) return null;
    let stem = pathMatch[1]; // e.g. "GestationalOverviewT" or "OrientationsT"
    if (!/T$/i.test(stem)) return null;
    stem = stem.replace(/T$/i, ''); // "GestationalOverview", "Orientations"
    const parts = stem.split(/(?<=[a-z])(?=[A-Z])/).filter(Boolean);
    if (parts.length === 0) return null;
    return parts.join('_').toLowerCase().replace(/\s+/g, '_') + '_t';
}

// Extract lessonId from HTML file
async function extractLessonIdFromHTML(lessonPath) {
    try {
        const response = await fetch(lessonPath);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${lessonPath}`);
        }
        const html = await response.text();
        
        // Look for: const lessonId = "..."
        const match = html.match(/const\s+lessonId\s*=\s*["']([^"']+)["']/);
        if (match) {
            return match[1];
        }
        
        return lessonIdFromPath(lessonPath);
    } catch (error) {
        console.error(`Error extracting lessonId from ${lessonPath}:`, error);
        return lessonIdFromPath(lessonPath);
    }
}

async function scanLessons() {
    try {
        requireAuth(); // Ensure user is authenticated
    } catch (error) {
        setStatus('Authentication required', 'error');
        return;
    }
    
    setStatus('Scanning lessons from menu...', 'scanning');
    const refreshBtn = refreshVideosBtn;
    if (refreshBtn) refreshBtn.disabled = true;
    const lessonDetailEl = document.getElementById('lessonDetail');
    const sidebarTreeEl = document.getElementById('sidebarTree');
    if (lessonDetailEl) lessonDetailEl.innerHTML = '<div class="spinner"></div>';
    if (sidebarTreeEl) sidebarTreeEl.innerHTML = '';
    
    try {
        // Step 1: Parse central menu to get all lesson paths
        setStatus('Parsing central menu...', 'scanning');
        const menuLessons = await parseCentralMenu();
        console.log(`Found ${menuLessons.length} lessons in menu`);
        
        // Step 2: Extract lessonIds from each HTML file
        setStatus('Extracting lesson IDs and sections...', 'scanning');
        lessonsData = [];
        const extractPromises = [];
        
        for (const menuLesson of menuLessons) {
            extractPromises.push(
                extractLessonIdFromHTML(menuLesson.path).then(lessonId => {
                    if (lessonId) {
                        return {
                            path: menuLesson.path,
                            name: menuLesson.name,
                            lessonId: lessonId,
                            section: menuLesson.section || 'Uncategorized',
                            originalName: menuLesson.name,
                            originalSection: menuLesson.section || 'Uncategorized'
                        };
                    }
                    return null;
                })
            );
        }
        
        const extractedLessons = (await Promise.all(extractPromises)).filter(l => l !== null);
        console.log(`Extracted ${extractedLessons.length} lesson IDs`);
        
        // Step 3: Check Firestore for videoPath, lesson metadata, section names, and video availability
        setStatus('Checking video availability and metadata...', 'scanning');
        const checkPromises = [];
        
        for (const lesson of extractedLessons) {
            checkPromises.push(
                (async () => {
                    // Check videoPaths collection for custom videoPath
                    const videoPathDoc = await db.collection('videoPaths').doc(lesson.lessonId).get();
                    const videoPathData = videoPathDoc.exists ? videoPathDoc.data() : {};
                    const customVideoPath = videoPathData.videoPath || null;
                    
                    // Optional lesson-level metadata overrides (display name)
                    const metadataDoc = await db.collection('lessonMetadata').doc(lesson.lessonId).get();
                    const metadata = metadataDoc.exists ? metadataDoc.data() : {};
                    const displayNameOverride = metadata.displayName || null;

                    // Optional section-level display name override (shared by all lessons in a section)
                    const sectionDoc = await db.collection('sectionNames').doc(lesson.originalSection).get();
                    const sectionData = sectionDoc.exists ? sectionDoc.data() : {};
                    const sectionDisplayNameOverride = sectionData.displayName || null;
                    
                    // Check if video exists
                    const videoCheck = await checkVideoAvailability(lesson.lessonId, customVideoPath);
                    
                    return {
                        path: lesson.path,
                        name: displayNameOverride || lesson.name,
                        lessonId: lesson.lessonId,
                        section: sectionDisplayNameOverride || lesson.section,
                        originalName: lesson.originalName,
                        originalSection: lesson.originalSection,
                        hasVideo: videoCheck.exists,
                        currentPath: customVideoPath || `videos/${lesson.lessonId}.mp4`,
                        error: videoCheck.error
                    };
                })()
            );
        }
        
        lessonsData = await Promise.all(checkPromises);
        
        // Sort: missing videos first, then by name
        lessonsData.sort((a, b) => {
            if (a.hasVideo && !b.hasVideo) return 1;
            if (!a.hasVideo && b.hasVideo) return -1;
            return a.name.localeCompare(b.name);
        });
        
        renderSidebarTree();
        displaySelectedLesson();
        
        const missingCount = lessonsData.filter(l => !l.hasVideo).length;
        const totalCount = lessonsData.length;
        
        updateVideosCountDisplay();
        setStatus(`Scan complete: ${missingCount} missing, ${totalCount - missingCount} found`, 
                  missingCount > 0 ? 'error' : 'success');
    } catch (error) {
        console.error('Error scanning lessons:', error);
        setStatus('Error scanning lessons: ' + error.message, 'error');
        const lessonDetail = document.getElementById('lessonDetail');
        if (lessonDetail) lessonDetail.innerHTML = '<p class="placeholder">Error loading lessons</p>';
    } finally {
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

// Refresh the entire admin dashboard: lessons tree, selected lesson, timeline editor, and available videos
async function refreshDashboard() {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }

    if (!refreshVideosBtn) {
        await scanLessons();
        await loadAvailableVideos();
        return;
    }

    setButtonLoading(refreshVideosBtn, true);
    setStatus('Refreshing dashboard...', 'scanning');

    try {
        await scanLessons();
        await loadAvailableVideos();

        // scanLessons already calls renderSidebarTree + displaySelectedLesson
        // loadAvailableVideos updates the videos card and counts
        if (selectedLessonId) {
            displaySelectedLesson();
            await refreshSrcArrayEditor();
        }

        setStatus('Dashboard refreshed', 'success');
        setTimeout(() => setStatus('Ready'), 2500);
    } catch (error) {
        console.error('Error refreshing dashboard:', error);
        setStatus('Error refreshing dashboard: ' + error.message, 'error');
    } finally {
        setButtonLoading(refreshVideosBtn, false);
    }
}

async function checkVideoAvailability(lessonId, customVideoPath) {
    try {
        const storageRef = storage.ref();
        const videoPath = customVideoPath || `videos/${lessonId}.mp4`;
        const fileRef = storageRef.child(videoPath);
        
        // Try to get download URL - if it fails, video doesn't exist
        await fileRef.getDownloadURL();
        return { exists: true, error: null };
    } catch (error) {
        // Check if it's a "not found" error
        if (error.code === 'storage/object-not-found' || error.code === 'storage/unauthorized') {
            return { exists: false, error: 'Video not found' };
        }
        return { exists: false, error: error.message };
    }
}

function getFilteredLessons() {
    return lessonsData.filter(lesson => {
        if (searchQuery) {
            const matchesSearch = lesson.name.toLowerCase().includes(searchQuery) ||
                                 lesson.lessonId.toLowerCase().includes(searchQuery) ||
                                 lesson.path.toLowerCase().includes(searchQuery);
            if (!matchesSearch) return false;
        }
        if (currentFilter === 'missing') return !lesson.hasVideo;
        if (currentFilter === 'has-video') return lesson.hasVideo;
        return true;
    });
}

function renderSidebarTree() {
    const treeEl = document.getElementById('sidebarTree');
    if (!treeEl) return;
    if (lessonsData.length === 0) {
        treeEl.innerHTML = '<p class="placeholder">Click "Scan All Lessons" to load the tree</p>';
        return;
    }
    const filteredLessons = getFilteredLessons();
    if (filteredLessons.length === 0) {
        treeEl.innerHTML = '<p class="placeholder">No lessons match your search/filter</p>';
        return;
    }
    const groups = {};
    for (const lesson of filteredLessons) {
        const key = lesson.originalSection || 'Uncategorized';
        if (!groups[key]) {
            groups[key] = {
                originalSection: key,
                sectionName: lesson.section || key,
                lessons: []
            };
        }
        groups[key].lessons.push(lesson);
    }
    const sections = Object.values(groups).sort((a, b) =>
        a.sectionName.localeCompare(b.sectionName)
    );
    const html = sections.map(section => {
        const safeSectionName = section.sectionName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeOriginalSection = section.originalSection.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const sectionKey = section.originalSection.replace(/[^a-zA-Z0-9_-]/g, '_');
        const isCollapsed = collapsedSections.has(section.originalSection);
        const lessonRows = section.lessons
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(lesson => {
                const safeLessonName = lesson.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const status = '●';
                const statusClass = lesson.hasVideo ? 'has-video' : 'missing';
                const selectedClass = selectedLessonId === lesson.lessonId ? ' selected' : '';
                const escId = lesson.lessonId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                return `<div class="tree-lesson ${statusClass}${selectedClass}" data-lesson-id="${lesson.lessonId}" onclick="selectLesson('${escId}')"><span class="tree-lesson-status">${status}</span><span class="tree-lesson-name">${safeLessonName}</span></div>`;
            }).join('');
        const sectionKeyAttr = section.originalSection.replace(/"/g, '&quot;');
        return `
            <div class="tree-section${isCollapsed ? ' collapsed' : ''}" data-section="${sectionKeyAttr}">
                <div class="tree-section-header">
                    <span class="tree-section-chevron">▼</span>
                    <span class="tree-section-title">${safeSectionName}</span>
                </div>
                <div class="tree-section-edit">
                    <input type="text" class="section-index-input" id="section-index-input-${sectionKey}" value="${safeSectionName}">
                    <button type="button" class="btn-section-save" onclick="saveSectionDisplayName('${section.originalSection.replace(/'/g, "\\'")}', this)">Save</button>
                </div>
                <div class="tree-section-children">${lessonRows}</div>
            </div>`;
    }).join('');
    treeEl.innerHTML = html;
}

async function displaySelectedLesson() {
    const panel = document.getElementById('lessonDetail');
    if (!panel) return;
    if (!selectedLessonId) {
        panel.innerHTML = '<p class="placeholder">Select a lesson from the tree</p>';
        return;
    }
    const lesson = lessonsData.find(l => l.lessonId === selectedLessonId);
    if (!lesson) {
        panel.innerHTML = '<p class="placeholder">Lesson not found</p>';
        return;
    }
    let forceFirstChapterStartAtZero = false;
    try {
        const lessonDoc = await db.collection('lessons').doc(selectedLessonId).get();
        if (lessonDoc.exists) {
            forceFirstChapterStartAtZero = lessonDoc.data().forceFirstChapterStartAtZero === true;
        }
    } catch (err) {
        console.warn('Could not load lesson playback settings:', err);
    }
    panel.innerHTML = getLessonCardHTML(lesson, { forceFirstChapterStartAtZero });
}

function getLessonCardHTML(lesson, playbackOpts) {
    const statusClass = lesson.hasVideo ? 'has-video' : 'missing';
    const statusText = lesson.hasVideo ? 'Has Video' : 'Missing';
    const forceAtZero = playbackOpts && playbackOpts.forceFirstChapterStartAtZero === true;
    const forceAtZeroChecked = forceAtZero ? ' checked' : '';
    const videoOptions = availableVideos.map(video => {
        const selected = lesson.currentPath === `videos/${video}` ? 'selected' : '';
        return `<option value="${video}" ${selected}>${video}</option>`;
    }).join('');
    const safeName = lesson.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeLessonId = lesson.lessonId.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safePath = lesson.path.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeSection = (lesson.section || 'Uncategorized').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeOriginalName = (lesson.originalName || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeOriginalSection = (lesson.originalSection || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escId = lesson.lessonId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `
        <div class="lesson-item" id="lesson-${lesson.lessonId}">
            <div class="lesson-item-header">
                <span class="lesson-name">${safeName}</span>
                <span class="lesson-status ${statusClass}">${statusText}</span>
            </div>
            <div class="lesson-details">
                <div class="lesson-section">Section: ${safeSection}</div>
                <div class="lesson-original">
                    <span class="lesson-original-label">Original:</span>
                    <span class="lesson-original-values">${safeOriginalSection} &raquo; ${safeOriginalName}</span>
                </div>
                <div class="lesson-id">ID: ${safeLessonId}</div>
                <div class="lesson-path">Path: ${safePath}</div>
                <div class="current-video">Video: ${lesson.currentPath}</div>
            </div>
            <div class="lesson-assignment">
                <div class="lesson-metadata-edit">
                    <div class="metadata-row">
                        <label for="name-input-${lesson.lessonId}">Lesson Name:</label>
                        <input type="text" id="name-input-${lesson.lessonId}" value="${safeName}">
                    </div>
                    <button class="btn-metadata-save" onclick="saveLessonMetadata('${escId}', this)">Save Lesson Name</button>
                </div>
                <div class="assignment-row">
                    <select id="video-select-${lesson.lessonId}">
                        <option value="">${lesson.hasVideo ? 'Change video...' : 'Select a video...'}</option>
                        ${videoOptions}
                    </select>
                    <button class="assign-btn" onclick="assignVideo('${escId}', this)" id="assign-btn-${lesson.lessonId}">${lesson.hasVideo ? 'Update' : 'Assign'}</button>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="resetLessonAssignment('${escId}', this)"><span class="btn-label">Reset</span></button>
                    <!-- Regenerate-from-yellow disabled now that generation handles yellow in a single path -->
                </div>
                <div class="lesson-playback-settings">
                    <h4 class="lesson-playback-settings-title">Playback (temporary)</h4>
                    <label class="lesson-playback-settings-label">
                        <input type="checkbox" id="forceChapterStartZero-${lesson.lessonId}"${forceAtZeroChecked}>
                        Force first chapter to start at 0:00 (use video start; ignore mapped first yellow contentStart)
                    </label>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="saveLessonPlaybackSettings('${escId}', this)"><span class="btn-label">Save playback settings</span></button>
                    <p class="lesson-playback-settings-hint">Freeze markers (yellow/green) still control stop/resume. This only fixes lesson entry when title mapping is not ready.</p>
                </div>
                <div class="lesson-chapters-block">
                    <button type="button" class="btn btn-secondary btn-chapters" onclick="showChaptersForLesson('${escId}')"><span class="btn-label">Show chapters</span></button>
                    <div id="chapters-container-${lesson.lessonId}" class="chapters-container" style="display:none;">
                        <div class="chapters-toolbar">
                            <button type="button" class="btn btn-secondary btn-sm" onclick="adjustChapterIndexSequence('${escId}')">Adjust index sequence</button>
                            <button type="button" class="btn btn-primary btn-sm" onclick="saveAllChapters('${escId}', this)">Save all</button>
                        </div>
                        <div id="chapters-edit-list-${lesson.lessonId}" class="chapters-edit-list"></div>
                    </div>
                </div>
            </div>
        </div>`;
}

function selectLesson(lessonId) {
    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (lesson) collapsedSections.delete(lesson.originalSection);
    resetAiTitleMappingPanel();
    selectedLessonId = lessonId;
    renderSidebarTree();
    displaySelectedLesson();
    refreshSrcArrayEditor();
    const treeEl = document.getElementById('sidebarTree');
    if (treeEl) {
        const node = treeEl.querySelector(`.tree-lesson[data-lesson-id="${lessonId}"]`);
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

/** Get video path for a lesson (for Storage/callables). Timeline is keyed by lessonId only. */
async function getVideoPathForLesson(lessonId) {
    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (!lesson) return null;
    const videoPathDoc = await db.collection('videoPaths').doc(lessonId).get();
    return (videoPathDoc.exists && videoPathDoc.data().videoPath)
        ? videoPathDoc.data().videoPath
        : `videos/${lessonId}.mp4`;
}

/** Same ordering as Cloud Function loadOrderedChapterTitles (chapter editor is source of truth for names). */
async function getOrderedChapterTitlesForLesson(lessonId) {
    const metaDoc = await db.collection('lessonMetadata').doc(lessonId).get();
    if (!metaDoc.exists) return [];
    const meta = metaDoc.data() || {};
    const displayMap = meta.chapterDisplayNames || {};
    const menuLabels = meta.chapterMenuLabels || {};

    if (Array.isArray(meta.chapterOrder) && meta.chapterOrder.length > 0) {
        return meta.chapterOrder
            .map((menuId) => {
                const id = String(menuId).trim();
                if (!id) return null;
                if (displayMap[id] != null && String(displayMap[id]).trim() !== '') {
                    return String(displayMap[id]).trim();
                }
                if (menuLabels[id] != null && String(menuLabels[id]).trim() !== '') {
                    return String(menuLabels[id]).trim();
                }
                return id;
            })
            .filter(Boolean);
    }

    const orderedKeys = Object.keys(displayMap).sort((a, b) => {
        const na = parseInt(String(a).replace(/\D+/g, ''), 10);
        const nb = parseInt(String(b).replace(/\D+/g, ''), 10);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return String(a).localeCompare(String(b));
    });
    return orderedKeys
        .map((k) => {
            const fromDisplay = displayMap[k] != null ? String(displayMap[k]).trim() : '';
            if (fromDisplay) return fromDisplay;
            const fromMenu = menuLabels[k] != null ? String(menuLabels[k]).trim() : '';
            return fromMenu || String(k).trim();
        })
        .filter(Boolean);
}

/** Opening row + rows with finite src_start/src_end and src_start < src_end (matches Cloud Functions). */
function rowIncludedInPlayableTimeline(seg) {
    if (!seg) return false;
    if (seg.menuLink === 'Opening' || seg.role === 'opening') return true;
    const a = Number(seg.src_start);
    const b = Number(seg.src_end);
    return Number.isFinite(a) && Number.isFinite(b) && b > a;
}

function splitSrcArrayForEditor(srcArray) {
    const full = Array.isArray(srcArray) ? srcArray : [];
    const display = full.filter((seg) => rowIncludedInPlayableTimeline(seg));
    const legacyInvalid = full.filter((seg) => !rowIncludedInPlayableTimeline(seg));
    return { display, legacyInvalid };
}

/** Load srcArray from Firestore for the Timeline editor (timeline keyed by lessonId). */
async function loadSrcArrayForEditor(lessonId) {
    const lessonDoc = await db.collection('lessons').doc(lessonId).get();
    const data = lessonDoc.exists ? lessonDoc.data() : {};
    const srcArray = data.srcArray ? data.srcArray : [];
    const timelinePipeline = data.timelinePipeline || null;
    const timelineReview = data.timelineReview || null;
    const yellowDetection = data.yellowDetection || null;
    const greenDetection = data.greenDetection || null;
    const redDetection = data.redDetection || null;
    const markerModelContext = data.markerModelContext || null;
    const yellowScreenEvents = data.yellowScreenEvents || null;
    const unmappedChapters = (yellowDetection && Array.isArray(yellowDetection.unmappedChapters))
        ? yellowDetection.unmappedChapters
        : [];
    const timelineGenerationSummary = yellowDetection && yellowDetection.timelineGenerationSummary
        ? yellowDetection.timelineGenerationSummary
        : null;
    return {
        lessonId,
        srcArray,
        timelinePipeline,
        timelineReview,
        yellowDetection,
        greenDetection,
        redDetection,
        markerModelContext,
        yellowScreenEvents,
        unmappedChapters,
        timelineGenerationSummary,
    };
}

function renderYellowEventsDebugPanel(yellowDetection, yellowScreenEvents) {
    const wrap = document.getElementById('yellowEventsDebugWrap');
    const preEv = document.getElementById('yellowEventsDebugEvents');
    const preEx = document.getElementById('yellowEventsDebugExplain');
    if (!wrap || !preEv) return;
    if (yellowDetection == null && yellowScreenEvents == null) {
        wrap.hidden = true;
        return;
    }
    const fromDet = yellowDetection && Array.isArray(yellowDetection.events) ? yellowDetection.events : null;
    const events = fromDet || (Array.isArray(yellowScreenEvents) ? yellowScreenEvents : []);
    const expl = yellowDetection && yellowDetection.segmentBuildExplanation;
    if (events.length === 0 && !expl) {
        wrap.hidden = true;
        return;
    }
    wrap.hidden = false;
    if (events.length) {
        preEv.textContent = JSON.stringify(events.map((ev) => ({
            eventIndex: ev.eventIndex,
            yellowStart: ev.yellowStart != null ? ev.yellowStart : ev.startTime,
            yellowEnd: ev.yellowEnd != null ? ev.yellowEnd : ev.endTime,
            contentStart: ev.contentStart,
            detectionConfidence: ev.detectionConfidence,
            metrics: ev.metrics,
        })), null, 2);
    } else {
        preEv.textContent = '(no events in yellowDetection.events / yellowScreenEvents)';
    }
    if (preEx) {
        preEx.textContent = expl ? JSON.stringify(expl, null, 2) : '(no segmentBuildExplanation)';
    }
}

function formatFloatMaybe(v) {
    return Number.isFinite(Number(v)) ? (Math.round(Number(v) * 1000) / 1000) : '—';
}

function escapeHtmlMini(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function summarizeGreenDetection(greenDetection) {
    const gd = greenDetection || {};
    const csum = gd.candidateSpanSummary || {};
    const raw = Array.isArray(gd.rawCandidateSpans) ? gd.rawCandidateSpans : [];
    const events = Array.isArray(gd.events) ? gd.events : [];
    const rejected = Array.isArray(gd.rejectedSpans) ? gd.rejectedSpans : raw.filter((s) => s && s.rejected);
    const candidateSpanCount = Number.isFinite(csum.candidateSpanCount) ? csum.candidateSpanCount : raw.length;
    const acceptedEventCount = Number.isFinite(gd.acceptedEventCount) ? gd.acceptedEventCount : events.length;
    const rejectedSpanCount = Number.isFinite(csum.rejectedSpanCount) ? csum.rejectedSpanCount : rejected.length;
    return {
        candidateSpanCount,
        acceptedEventCount,
        rejectedSpanCount,
        zeroReason: gd.zeroReason || null,
        rejectionReasonSummary: gd.rejectionReasonSummary || {},
        events,
        rejectedSpans: rejected,
    };
}

function renderGreenDetectionPanels(greenDetection, showWhenEmpty = false) {
    const debugWrap = document.getElementById('greenDetectionDebugWrap');
    const summaryPre = document.getElementById('greenDetectionSummaryPre');
    const eventsTbody = document.getElementById('greenDetectionEventsTbody');
    const rejectedPre = document.getElementById('greenDetectionRejectedPre');
    const scaffoldWrap = document.getElementById('greenMappingScaffoldWrap');
    const scaffoldTbody = document.getElementById('greenMappingScaffoldTbody');
    if (!debugWrap || !summaryPre || !eventsTbody || !rejectedPre || !scaffoldWrap || !scaffoldTbody) return;

    if (!showWhenEmpty && !greenDetection) {
        debugWrap.hidden = true;
        scaffoldWrap.hidden = true;
        return;
    }

    const s = summarizeGreenDetection(greenDetection);
    debugWrap.hidden = false;
    scaffoldWrap.hidden = false;

    summaryPre.textContent = JSON.stringify({
        candidateSpanCount: s.candidateSpanCount,
        acceptedEventCount: s.acceptedEventCount,
        rejectedSpanCount: s.rejectedSpanCount,
        zeroReason: s.zeroReason,
        rejectionReasonSummary: s.rejectionReasonSummary,
    }, null, 2);

    if (s.events.length > 0) {
        eventsTbody.innerHTML = s.events.map((ev) => {
            const greenStart = ev.greenStart != null ? ev.greenStart : ev.startTime;
            const greenEnd = ev.greenEnd != null ? ev.greenEnd : ev.endTime;
            const freezeTime = ev.freezeTime != null ? ev.freezeTime : greenStart;
            const resumeTime = ev.resumeTime != null ? ev.resumeTime : greenEnd;
            return `<tr>
                <td>${escapeHtmlMini(ev.eventIndex != null ? ev.eventIndex : '—')}</td>
                <td>${escapeHtmlMini(formatFloatMaybe(greenStart))}</td>
                <td>${escapeHtmlMini(formatFloatMaybe(greenEnd))}</td>
                <td>${escapeHtmlMini(formatFloatMaybe(freezeTime))}</td>
                <td>${escapeHtmlMini(formatFloatMaybe(resumeTime))}</td>
                <td>${escapeHtmlMini(formatFloatMaybe(ev.detectionConfidence))}</td>
            </tr>`;
        }).join('');
    } else {
        eventsTbody.innerHTML = '<tr><td colspan="6">No accepted green events.</td></tr>';
    }

    rejectedPre.textContent = s.rejectedSpans.length > 0
        ? JSON.stringify(s.rejectedSpans, null, 2)
        : '(no rejected green spans)';

    if (s.events.length > 0) {
        scaffoldTbody.innerHTML = s.events.map((ev) => {
            const greenStart = ev.greenStart != null ? ev.greenStart : ev.startTime;
            const freezeTime = ev.freezeTime != null ? ev.freezeTime : greenStart;
            return `<tr>
                <td>${escapeHtmlMini(ev.eventIndex != null ? ev.eventIndex : '—')}</td>
                <td>${escapeHtmlMini(formatFloatMaybe(greenStart))}</td>
                <td>${escapeHtmlMini(formatFloatMaybe(freezeTime))}</td>
                <td class="green-mapping-placeholder">Pending OCR/title-frame detection</td>
                <td class="green-mapping-placeholder">Pending menu-title match</td>
                <td class="green-mapping-placeholder">Scaffold only</td>
                <td class="green-mapping-placeholder">Coming soon</td>
                <td class="green-mapping-placeholder">Green can freeze + anchor mapping</td>
            </tr>`;
        }).join('');
    } else {
        scaffoldTbody.innerHTML = '<tr><td colspan="8" class="green-mapping-placeholder">No green events yet. Future title/menu mapping rows will appear here.</td></tr>';
    }
}

function buildGreenSummaryLineFromResponse(greenDetectionSummary) {
    if (!greenDetectionSummary || typeof greenDetectionSummary !== 'object') return '';
    const c = Number.isFinite(greenDetectionSummary.candidateSpanCount) ? greenDetectionSummary.candidateSpanCount : 0;
    const a = Number.isFinite(greenDetectionSummary.acceptedEventCount) ? greenDetectionSummary.acceptedEventCount : 0;
    const r = Number.isFinite(greenDetectionSummary.rejectedSpanCount) ? greenDetectionSummary.rejectedSpanCount : 0;
    let line = ` Green spans: ${c} candidate, ${a} accepted, ${r} rejected.`;
    if (a === 0 && greenDetectionSummary.zeroReason) {
        line += ` Green zeroReason: ${greenDetectionSummary.zeroReason}.`;
    }
    const rej = greenDetectionSummary.rejectionReasonSummary;
    if (rej && typeof rej === 'object' && Object.keys(rej).length > 0) {
        line += ` Rejections: ${JSON.stringify(rej)}.`;
    }
    return line;
}

function renderMarkerModelContextPanel(markerModelContext) {
    const wrap = document.getElementById('markerModelContextWrap');
    const pre = document.getElementById('markerModelContextPre');
    if (!wrap || !pre) return;
    const ctx = markerModelContext && typeof markerModelContext === 'object'
        ? markerModelContext
        : DEFAULT_MARKER_MODEL_CONTEXT;
    wrap.hidden = false;
    pre.textContent = JSON.stringify(ctx, null, 2);
}

function summarizeRedDetection(redDetection) {
    const rd = redDetection || {};
    const events = Array.isArray(rd.events) ? rd.events : [];
    return {
        status: rd.status || 'provisional_not_implemented',
        eventCount: events.length,
        loopModel: rd.loopModel || { implemented: false },
        unresolvedQuestions: Array.isArray(rd.unresolvedQuestions) ? rd.unresolvedQuestions : [],
        samplePlaybackRequired: rd.samplePlaybackRequired === true,
        zeroReason: rd.zeroReason || null,
        thresholds: rd.thresholds || null,
        events,
    };
}

function renderRedDetectionPanel(redDetection, showWhenEmpty = false) {
    const wrap = document.getElementById('redDetectionScaffoldWrap');
    const summaryPre = document.getElementById('redDetectionSummaryPre');
    const tbody = document.getElementById('redDetectionEventsTbody');
    if (!wrap || !summaryPre || !tbody) return;
    if (!showWhenEmpty && !redDetection) {
        wrap.hidden = true;
        return;
    }
    const s = summarizeRedDetection(redDetection);
    const implemented = s.loopModel && s.loopModel.implemented === true;
    wrap.hidden = false;
    summaryPre.textContent = JSON.stringify({
        status: s.status,
        eventCount: s.eventCount,
        loopModel: s.loopModel,
        thresholds: s.thresholds,
        zeroReason: s.zeroReason,
        unresolvedQuestions: s.unresolvedQuestions,
        samplePlaybackRequired: s.samplePlaybackRequired,
    }, null, 2);
    if (s.events.length > 0) {
        tbody.innerHTML = s.events.map((ev, idx) => {
            const redStart = ev.redStart != null ? ev.redStart : ev.startTime;
            const redEnd = ev.redEnd != null ? ev.redEnd : ev.endTime;
            const loopTarget = ev.loopTargetFreezeEvent != null
                ? ev.loopTargetFreezeEvent
                : (implemented ? 'Previous freeze (runtime)' : 'Pending rules');
            const conf = ev.detectionConfidence != null ? formatFloatMaybe(ev.detectionConfidence) : 'n/a';
            return `<tr>
                <td>${escapeHtmlMini(ev.eventIndex != null ? ev.eventIndex : idx + 1)}</td>
                <td>${escapeHtmlMini(formatFloatMaybe(redStart))}</td>
                <td>${escapeHtmlMini(formatFloatMaybe(redEnd))}</td>
                <td>${escapeHtmlMini(loopTarget)}</td>
                <td>${escapeHtmlMini((ev.status || (implemented ? 'detected' : 'provisional')) + ' (conf ' + conf + ')')}</td>
            </tr>`;
        }).join('');
    } else {
        const emptyMsg = implemented
            ? 'No red loop cards detected in this video (detector ran). ' + (s.zeroReason ? '(' + s.zeroReason + ')' : '')
            : 'No red events yet. Loop-marker model is scaffolded pending real sample verification.';
        tbody.innerHTML = '<tr><td colspan="5">' + escapeHtmlMini(emptyMsg) + '</td></tr>';
    }
}

function renderUnmappedAndLegacyPanels(unmappedChapters, timelineGenerationSummary, legacyInvalid) {
    const uWrap = document.getElementById('unmappedChaptersWrap');
    const uPre = document.getElementById('unmappedChaptersPre');
    const lWrap = document.getElementById('legacyInvalidRowsWrap');
    const lPre = document.getElementById('legacyInvalidRowsPre');
    if (uWrap && uPre) {
        const hasU = Array.isArray(unmappedChapters) && unmappedChapters.length > 0;
        const hasS = timelineGenerationSummary && typeof timelineGenerationSummary === 'object';
        if (hasU || hasS) {
            uWrap.hidden = false;
            uPre.textContent = JSON.stringify({
                timelineGenerationSummary: hasS ? timelineGenerationSummary : null,
                unmappedChapters: hasU ? unmappedChapters : [],
            }, null, 2);
        } else {
            uWrap.hidden = true;
            uPre.textContent = '';
        }
    }
    if (lWrap && lPre) {
        if (Array.isArray(legacyInvalid) && legacyInvalid.length > 0) {
            lWrap.hidden = false;
            lPre.textContent = JSON.stringify(legacyInvalid.map((seg, i) => ({
                legacyIndex: i,
                chapterIndex: seg.chapterIndex,
                menuLink: seg.menuLink,
                src_start: seg.src_start,
                src_end: seg.src_end,
                status: seg.status,
            })), null, 2);
        } else {
            lWrap.hidden = true;
            lPre.textContent = '';
        }
    }
}

function renderSrcArrayTable(srcArray, lessonId, chapterTitles, panelExtras) {
    const tbody = document.getElementById('srcArrayEditorTbody');
    const tableWrap = document.querySelector('.srcarray-editor-table-wrap');
    const emptyEl = document.getElementById('srcArrayEditorEmpty');
    if (!tbody || !tableWrap || !emptyEl) return;

    const { display, legacyInvalid } = splitSrcArrayForEditor(srcArray);
    const unmappedChapters = panelExtras && panelExtras.unmappedChapters;
    const timelineGenerationSummary = panelExtras && panelExtras.timelineGenerationSummary;
    renderUnmappedAndLegacyPanels(unmappedChapters, timelineGenerationSummary, legacyInvalid);

    currentSrcArrayForEditor = display.map(s => ({ ...s }));
    currentSrcArrayLessonId = lessonId;
    currentChapterTitlesForEditor = Array.isArray(chapterTitles) ? chapterTitles : [];

    if (currentSrcArrayForEditor.length === 0) {
        tbody.innerHTML = '';
        tableWrap.style.display = 'none';
        emptyEl.style.display = 'block';
        return;
    }

    tableWrap.style.display = 'block';
    emptyEl.style.display = 'none';

    const esc = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');

    const rows = currentSrcArrayForEditor.map((seg, index) => {
        const start = seg.src_start != null ? Number(seg.src_start) : '';
        const end = seg.src_end != null ? Number(seg.src_end) : '';
        const menuLink = seg.menuLink != null ? String(seg.menuLink) : '';
        const chNum = seg.chapterIndex != null ? Number(seg.chapterIndex) : '';
        const fromEditor = (Number.isFinite(chNum) && chNum > 0 && currentChapterTitlesForEditor[chNum - 1])
            ? currentChapterTitlesForEditor[chNum - 1]
            : '';
        const yellowStart = seg.yellowStart != null ? Number(seg.yellowStart) : '';
        const yellowEnd = seg.yellowEnd != null ? Number(seg.yellowEnd) : '';
        const source = seg.source != null ? String(seg.source) : '';
        const conf = seg.confidence != null ? String(seg.confidence) : '';
        const flagged = seg.flagged === true;
        const manualOverride = seg.manualOverride === true;
        return `<tr data-index="${index}">
            <td class="srcarray-col-index">${index}</td>
            <td><input type="number" step="0.01" class="srcarray-input-start" value="${start}" data-index="${index}"></td>
            <td><input type="number" step="0.01" class="srcarray-input-end" value="${end}" data-index="${index}"></td>
            <td><input type="number" step="1" min="0" class="srcarray-input-chapterIndex" value="${chNum === '' ? '' : chNum}" data-index="${index}" placeholder="—"></td>
            <td class="srcarray-chapter-name" title="From lesson chapter editor (ordered list)">${esc(fromEditor || '—')}</td>
            <td><input type="text" class="srcarray-input-menuLink" value="${esc(menuLink)}" data-index="${index}" placeholder="menu link"></td>
            <td><input type="checkbox" class="srcarray-input-flagged" data-index="${index}" ${flagged ? 'checked' : ''}></td>
            <td><input type="checkbox" class="srcarray-input-manualOverride" data-index="${index}" ${manualOverride ? 'checked' : ''} title="Preserve on regenerate"></td>
            <td>
                <details class="srcarray-details">
                    <summary>debug</summary>
                    <div class="srcarray-details-grid">
                        <span>yellowStart</span><span>${esc(yellowStart === '' ? '—' : yellowStart)}</span>
                        <span>yellowEnd</span><span>${esc(yellowEnd === '' ? '—' : yellowEnd)}</span>
                        <span>title</span><span>${esc(seg.title != null ? seg.title : '—')}</span>
                        <span>source</span><span>${esc(source || '—')}</span>
                        <span>confidence</span><span>${esc(conf || '—')}</span>
                    </div>
                </details>
            </td>
        </tr>`;
    }).join('');
    tbody.innerHTML = rows;
}

function resetAiTitleMappingPanel() {
    const st = document.getElementById('aiTitleMappingStatus');
    const res = document.getElementById('aiTitleMappingResults');
    if (st) {
        st.textContent = 'Idle';
        st.className = 'srcarray-editor-ai-status ai-mapping-idle';
    }
    if (res) {
        res.hidden = true;
        res.innerHTML = '';
    }
}

function setAiTitleMappingStatus(state, message) {
    const st = document.getElementById('aiTitleMappingStatus');
    if (!st) return;
    const map = {
        idle: 'ai-mapping-idle',
        running: 'ai-mapping-running',
        success: 'ai-mapping-success',
        failed: 'ai-mapping-failed',
    };
    st.className = `srcarray-editor-ai-status ${map[state] || map.idle}`;
    st.textContent = message || state;
}

function escapeHtmlAdmin(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function renderAiTitleMappingResults(data) {
    const el = document.getElementById('aiTitleMappingResults');
    if (!el) return;
    const rb = data.resultsByEventIndex || {};
    const keys = Object.keys(rb).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const errs = data.errors || [];
    let head = `<p><strong>Model:</strong> ${escapeHtmlAdmin(data.model)} · <strong>Processed:</strong> ${data.processedEventCount != null ? data.processedEventCount : '—'} · <strong>Mapped:</strong> ${data.mappedCount != null ? data.mappedCount : '—'} · <strong>Manual review:</strong> ${data.manualReviewCount != null ? data.manualReviewCount : '—'}</p>`;
    if (errs.length) {
        head += `<p><strong>Errors (${errs.length}):</strong> ${escapeHtmlAdmin(JSON.stringify(errs))}</p>`;
    }
    if (keys.length === 0) {
        el.innerHTML = head + '<p>No per-event rows in resultsByEventIndex.</p>';
        el.hidden = false;
        return;
    }
    const rows = keys.map((k) => {
        const r = rb[k] || {};
        return `<tr>
            <td>${escapeHtmlAdmin(k)}</td>
            <td>${escapeHtmlAdmin(r.bestChapterIndex)}</td>
            <td>${escapeHtmlAdmin(r.matchedTitle)}</td>
            <td>${escapeHtmlAdmin(r.confidence)}</td>
            <td>${escapeHtmlAdmin(r.needsManualReview)}</td>
            <td>${escapeHtmlAdmin(r.reason)}</td>
        </tr>`;
    }).join('');
    el.innerHTML = head + `<table><thead><tr><th>Event</th><th>Ch#</th><th>Matched title</th><th>Confidence</th><th>Review?</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>`;
    el.hidden = false;
}

async function refreshSrcArrayEditor() {
    const statusEl = document.getElementById('srcArrayEditorStatus');
    if (!selectedLessonId) {
        currentSrcArrayForEditor = [];
        currentSrcArrayLessonId = null;
        currentChapterTitlesForEditor = [];
        renderSrcArrayTable([], null, [], {});
        renderYellowEventsDebugPanel(null, null);
        renderGreenDetectionPanels(null, false);
        renderRedDetectionPanel(null, false);
        renderMarkerModelContextPanel(null);
        if (statusEl) statusEl.textContent = '';
        resetAiTitleMappingPanel();
        return;
    }
    if (statusEl) statusEl.textContent = 'Loading…';
    try {
        const {
            lessonId,
            srcArray,
            timelinePipeline,
            timelineReview,
            yellowDetection,
            greenDetection,
            redDetection,
            markerModelContext,
            yellowScreenEvents,
            unmappedChapters,
            timelineGenerationSummary,
        } = await loadSrcArrayForEditor(selectedLessonId);
        const chapterTitles = await getOrderedChapterTitlesForLesson(selectedLessonId);
        renderSrcArrayTable(srcArray, selectedLessonId, chapterTitles, {
            unmappedChapters,
            timelineGenerationSummary,
        });
        renderYellowEventsDebugPanel(yellowDetection, yellowScreenEvents);
        renderGreenDetectionPanels(greenDetection, true);
        renderRedDetectionPanel(redDetection, true);
        renderMarkerModelContextPanel(markerModelContext);
        if (statusEl) {
            const { display: playableRows, legacyInvalid } = splitSrcArrayForEditor(srcArray);
            let line = selectedLessonId
                ? `${playableRows.length} playable row(s)`
                : 'No lesson selected';
            if (selectedLessonId && legacyInvalid.length > 0) {
                line += ` · ${legacyInvalid.length} legacy invalid row(s) not shown`;
            }
            const genOk = timelinePipeline && timelinePipeline.status === 'ok';
            const genFailed = timelineReview && timelineReview.generationFailed === true;
            if (genOk && !genFailed) {
                line += ' · Last generate: OK';
            } else if (timelinePipeline && timelinePipeline.status === 'no_yellow_detected') {
                line += ' · Last generate: no yellow detected (see yellowDetection)';
            } else if (genFailed) {
                line += ' · Last generate failed';
            }
            if (greenDetection) {
                const g = summarizeGreenDetection(greenDetection);
                line += ` · Green ${g.acceptedEventCount}/${g.candidateSpanCount} accepted`;
                if (g.acceptedEventCount === 0 && g.zeroReason) {
                    line += ` (${g.zeroReason})`;
                }
            } else {
                line += ' · Green detection pending/empty';
            }
            const redSummary = summarizeRedDetection(redDetection);
            line += ` · Red: ${redSummary.status}`;
            statusEl.textContent = line;
        }
    } catch (e) {
        console.error('refreshSrcArrayEditor:', e);
        renderSrcArrayTable([], null, [], {});
        renderYellowEventsDebugPanel(null, null);
        renderGreenDetectionPanels(null, false);
        renderRedDetectionPanel(null, false);
        renderMarkerModelContextPanel(null);
        if (statusEl) statusEl.textContent = 'Error loading';
    }
}

function setupCollapsibleCard(cardId, toggleId, bodyId) {
    const card = document.getElementById(cardId);
    const toggleBtn = document.getElementById(toggleId);
    const body = document.getElementById(bodyId);
    if (!toggleBtn || !card || !body) return;
    toggleBtn.addEventListener('click', () => {
        const collapsed = card.classList.toggle('collapsed');
        body.hidden = collapsed;
        toggleBtn.setAttribute('aria-expanded', !collapsed);
    });
}

function setupSrcArrayEditorListeners() {
    setupCollapsibleCard('srcArrayEditorCard', 'srcArrayEditorToggle', 'srcArrayEditorBody');
    setupCollapsibleCard('selectedLessonCard', 'selectedLessonToggle', 'selectedLessonBody');
    setupCollapsibleCard('videosCard', 'videosCardToggle', 'videosCardBody');
    const saveBtn = document.getElementById('srcArraySaveAllBtn');
    const generateBtn = document.getElementById('srcArrayGenerateFromYellowBtn');
    const minSegInput = document.getElementById('srcArrayMinSegInput');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            if (!currentSrcArrayLessonId || currentSrcArrayForEditor.length === 0) {
                setStatus('No timeline to save. Select a lesson and open the editor.', 'error');
                return;
            }
            const tbody = document.getElementById('srcArrayEditorTbody');
            if (!tbody) return;
            const rows = tbody.querySelectorAll('tr[data-index]');
            const updated = [];
            for (const row of rows) {
                const index = parseInt(row.getAttribute('data-index'), 10);
                const seg = currentSrcArrayForEditor[index] ? { ...currentSrcArrayForEditor[index] } : {};
                const startInput = row.querySelector('.srcarray-input-start');
                const endInput = row.querySelector('.srcarray-input-end');
                const menuLinkInput = row.querySelector('.srcarray-input-menuLink');
                const chapterIdxInput = row.querySelector('.srcarray-input-chapterIndex');
                const flaggedInput = row.querySelector('.srcarray-input-flagged');
                const overrideInput = row.querySelector('.srcarray-input-manualOverride');
                if (startInput) seg.src_start = startInput.value === '' ? null : parseFloat(startInput.value);
                if (endInput) seg.src_end = endInput.value === '' ? null : parseFloat(endInput.value);
                if (menuLinkInput) seg.menuLink = menuLinkInput.value.trim() || '';
                if (chapterIdxInput) {
                    const raw = chapterIdxInput.value.trim();
                    seg.chapterIndex = raw === '' ? null : parseInt(raw, 10);
                }
                if (flaggedInput) seg.flagged = flaggedInput.checked;
                if (overrideInput) seg.manualOverride = overrideInput.checked;
                const ch = seg.chapterIndex;
                if (Number.isFinite(ch) && ch > 0 && currentChapterTitlesForEditor[ch - 1]) {
                    seg.title = currentChapterTitlesForEditor[ch - 1];
                }
                if (seg.src_start != null) {
                    seg.contentStart = seg.src_start;
                    seg.start = seg.src_start;
                }
                if (seg.src_end != null) {
                    seg.contentEnd = seg.src_end;
                    seg.end = seg.src_end;
                }
                updated.push(seg);
            }
            const playableOnly = updated.filter((seg) => rowIncludedInPlayableTimeline(seg));
            const dropped = updated.length - playableOnly.length;
            setButtonLoading(saveBtn, true);
            setStatus('Saving timeline…', 'scanning');
            try {
                await db.collection('lessons').doc(currentSrcArrayLessonId).set({ srcArray: playableOnly }, { merge: true });
                currentSrcArrayForEditor = playableOnly;
                const saveNote = dropped > 0 ? ` (${dropped} invalid row(s) omitted)` : '';
                setStatus(`Timeline saved${saveNote}`, 'success');
                const statusEl = document.getElementById('srcArrayEditorStatus');
                if (statusEl) statusEl.textContent = `${playableOnly.length} segment(s) saved`;
            } catch (e) {
                setStatus('Save failed: ' + e.message, 'error');
            } finally {
                setButtonLoading(saveBtn, false);
            }
        });
    }
    if (generateBtn && minSegInput) {
        generateBtn.addEventListener('click', async () => {
            if (!selectedLessonId) {
                setStatus('Select a lesson first', 'error');
                return;
            }
            try {
                requireAuth();
            } catch (error) {
                setStatus('Authentication required', 'error');
                return;
            }

            const minSegVal = parseFloat(minSegInput.value);
            const minSegmentSeconds = Number.isFinite(minSegVal) && minSegVal > 0 ? minSegVal : 0.05;

            try {
                setButtonLoading(generateBtn, true);
                setStatus(`Generating timeline (min yellow duration ${minSegmentSeconds}s)…`, 'scanning');

                const videoPath = await getVideoPathForLesson(selectedLessonId);
                if (!videoPath) {
                    setStatus('No video path for this lesson', 'error');
                    return;
                }

                const fn = functions.httpsCallable('generateSrcArrayWithYellowOptions', {
                    timeout: 540000,
                });
                const yellowDebugCalibration = document.getElementById('srcArrayYellowDebugCal')
                    ? document.getElementById('srcArrayYellowDebugCal').checked
                    : false;
                const result = await fn({
                    lessonId: selectedLessonId,
                    videoPath,
                    minSegmentSeconds,
                    yellowDebugCalibration,
                });

                const data = result.data || {};
                if (data.success === false) {
                    const reason = data.reason || 'unknown';
                    const msg = data.message || reason;
                    const gLine = buildGreenSummaryLineFromResponse(data.greenDetectionSummary);
                    setStatus(`Generate failed: ${msg}. Timeline not overwritten. Check lesson yellowDetection in Firestore.${gLine}`, 'error');
                    await refreshSrcArrayEditor();
                    return;
                }
                const segs = typeof data.segments === 'number' ? data.segments : 'updated';
                const yEv = typeof data.yellowEventsDetected === 'number' ? data.yellowEventsDetected : null;
                const ranges = typeof data.yellowRanges === 'number' ? data.yellowRanges : '?';
                const states = Array.isArray(data.reviewStates) && data.reviewStates.length
                    ? ` Review: ${data.reviewStates.join(', ')}.`
                    : '';
                const exp = data.segmentBuildExplanation;
                const sum = exp && Array.isArray(exp.summaryLines) ? ` ${exp.summaryLines.join(' ')}` : '';
                const chLine = typeof data.chapterTitlesLoaded === 'number'
                    ? ` Chapters loaded: ${data.chapterTitlesLoaded}.`
                    : '';
                const yLine = yEv != null ? ` Yellow events detected: ${yEv}.` : ` Yellow ranges: ${ranges}.`;
                const tg = data.timelineGenerationSummary;
                const tgLine = tg && typeof tg.validPlayableSegmentCount === 'number'
                    ? ` Playable segments: ${tg.validPlayableSegmentCount}. Unmapped chapters: ${tg.unmappedChapterCount != null ? tg.unmappedChapterCount : '—'}.`
                    : '';
                const gLine = buildGreenSummaryLineFromResponse(data.greenDetectionSummary);
                setStatus(`Generated ${segs} timeline row(s).${yLine}${chLine}${tgLine}${gLine}${sum}${states}`, 'success');

                await refreshSrcArrayEditor();
            } catch (e) {
                console.error('generateSrcArrayWithYellowOptions failed:', e);
                setStatus('Error generating timeline: ' + e.message, 'error');
            } finally {
                setButtonLoading(generateBtn, false);
            }
        });
    }

    const aiTitleMappingBtn = document.getElementById('aiTitleMappingBtn');
    if (aiTitleMappingBtn) {
        aiTitleMappingBtn.addEventListener('click', async () => {
            const resEl = document.getElementById('aiTitleMappingResults');
            if (!selectedLessonId) {
                setAiTitleMappingStatus('failed', 'Select a lesson first');
                setStatus('Select a lesson first', 'error');
                return;
            }
            try {
                requireAuth();
            } catch (err) {
                setAiTitleMappingStatus('failed', 'Authentication required');
                setStatus('Authentication required', 'error');
                return;
            }

            setButtonLoading(aiTitleMappingBtn, true);
            setAiTitleMappingStatus('running', 'Running…');
            if (resEl) {
                resEl.hidden = true;
                resEl.innerHTML = '';
            }

            try {
                const mapFn = functions.httpsCallable('mapYellowEventsToChaptersWithAI', {
                    timeout: 540000,
                });
                const result = await mapFn({ lessonId: selectedLessonId });
                const data = result.data || {};

                if (data.success === false) {
                    const msg = data.message || data.reason || 'AI title mapping failed';
                    setAiTitleMappingStatus('failed', msg);
                    if (resEl) {
                        resEl.innerHTML = `<p>${escapeHtmlAdmin(msg)}</p>`;
                        resEl.hidden = false;
                    }
                    setStatus(`AI title mapping: ${msg}`, 'error');
                    return;
                }

                const line = `OK · processed ${data.processedEventCount}, mapped ${data.mappedCount}, manual review ${data.manualReviewCount}`;
                setAiTitleMappingStatus('success', line);
                renderAiTitleMappingResults(data);
                setStatus('AI title mapping completed', 'success');
                await refreshSrcArrayEditor();
            } catch (err) {
                console.error('mapYellowEventsToChaptersWithAI failed:', err);
                let msg = err.message || String(err);
                if (err.code === 'functions/failed-precondition') {
                    msg = 'Server: OPENAI_API_KEY missing or AI not configured.';
                }
                setAiTitleMappingStatus('failed', msg);
                if (resEl) {
                    resEl.innerHTML = `<p>${escapeHtmlAdmin(msg)}</p>`;
                    resEl.hidden = false;
                }
                setStatus('AI title mapping failed: ' + msg, 'error');
            } finally {
                setButtonLoading(aiTitleMappingBtn, false);
            }
        });
    }
}

// Expose for tree section header click (collapse/expand)
function toggleSectionInSidebar(sectionKey) {
    if (collapsedSections.has(sectionKey)) collapsedSections.delete(sectionKey);
    else collapsedSections.add(sectionKey);
    renderSidebarTree();
}

window.selectLesson = selectLesson;
window.toggleSectionInSidebar = toggleSectionInSidebar;

async function saveLessonMetadata(lessonId, btn) {
    try {
        requireAuth(); // Ensure user is authenticated
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }

    const nameInput = document.getElementById(`name-input-${lessonId}`);
    const lesson = lessonsData.find(l => l.lessonId === lessonId);

    if (!nameInput || !lesson) {
        alert('Unable to find lesson metadata input.');
        return;
    }

    const newName = nameInput.value.trim();

    // Determine what actually changed relative to current effective values
    const hasLessonNameChange = newName !== lesson.name;

    // If nothing changed, skip write
    if (!hasLessonNameChange) {
        setStatus('No metadata changes to save', 'success');
        setTimeout(() => setStatus('Ready'), 2000);
        return;
    }

    setButtonLoading(btn, true);
    nameInput.disabled = true;

    try {
        const writes = [];

        // Save per-lesson display name override in lessonMetadata collection
        if (hasLessonNameChange) {
            const lessonDocRef = db.collection('lessonMetadata').doc(lessonId);

            // If user set it back to original or cleared it, remove the override field
            if (!newName || newName === lesson.originalName) {
                writes.push(
                    lessonDocRef.set(
                        { displayName: firebase.firestore.FieldValue.delete() },
                        { merge: true }
                    )
                );
            } else {
                writes.push(
                    lessonDocRef.set(
                        { displayName: newName },
                        { merge: true }
                    )
                );
            }
        }

        if (writes.length > 0) {
            await Promise.all(writes);
        }

        // Update local data: lesson name only for this lesson
        if (hasLessonNameChange) {
            if (!newName || newName === lesson.originalName) {
                lesson.name = lesson.originalName;
            } else {
                lesson.name = newName;
            }
        }

        renderSidebarTree();
        displaySelectedLesson();
        setStatus('Lesson metadata saved', 'success');
        setTimeout(() => setStatus('Ready'), 3000);
    } catch (error) {
        console.error('Error saving lesson metadata:', error);
        alert('Error saving lesson metadata: ' + error.message);
    } finally {
        nameInput.disabled = false;
        setButtonLoading(btn, false);
    }
}

// Load chapters from lesson HTML (menu buttons) and show dropdown + editable list
async function showChaptersForLesson(lessonId) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }

    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (!lesson) {
        setStatus('Lesson not found', 'error');
        return;
    }

    const container = document.getElementById(`chapters-container-${lessonId}`);
    const editList = document.getElementById(`chapters-edit-list-${lessonId}`);
    if (!container || !editList) return;

    setStatus('Detecting chapters from lesson...', 'scanning');

    try {
        const menuLinks = await extractMenuLinksFromHTML(lesson.path);
        if (!menuLinks.length) {
            editList.innerHTML = '<p class="chapters-empty">No chapter buttons found in this lesson.</p>';
            container.style.display = 'block';
            setStatus('No chapters detected', 'error');
            return;
        }

        const metaDoc = await db.collection('lessonMetadata').doc(lessonId).get();
        const meta = metaDoc.exists ? metaDoc.data() : {};
        const chapterDisplayNames = meta.chapterDisplayNames || {};
        const chapterSegmentMap = meta.chapterSegmentMap || {};
        const lessonDoc = await db.collection('lessons').doc(lessonId).get().catch(() => null);
        const srcArrayData = (lessonDoc && lessonDoc.exists) ? (lessonDoc.data().srcArray || []) : [];

        const chapters = menuLinks.map(m => ({
            menuId: m.menuId,
            originalLabel: m.label,
            displayName: chapterDisplayNames[m.menuId] !== undefined ? chapterDisplayNames[m.menuId] : m.label
        }));

        const chapterOrder = menuLinks.map(m => m.menuId);
        const chapterMenuLabels = Object.fromEntries(menuLinks.map(m => [m.menuId, m.label]));
        await db.collection('lessonMetadata').doc(lessonId).set({
            chapterOrder,
            chapterMenuLabels,
        }, { merge: true });

        editList.innerHTML = chapters.map((ch, idx) => {
            const safeOriginal = ch.originalLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const safeDisplay = ch.displayName.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const safeMenuIdAttr = ch.menuId.replace(/"/g, '&quot;');
            const menuIdEscaped = ch.menuId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            // Segment index: saved map > srcArray freezeFrame > mirror order (1, 2, 3, ...)
            const fromMap = chapterSegmentMap[ch.menuId];
            const fromSrc = (srcArrayData[idx] && typeof srcArrayData[idx].freezeFrame === 'number') ? srcArrayData[idx].freezeFrame : null;
            const currentSegmentIndex = (fromMap != null && !Number.isNaN(Number(fromMap)) && Number(fromMap) > 0)
                ? Number(fromMap)
                : (fromSrc != null ? fromSrc : idx + 1);
            return `
                <div class="chapter-row" data-menu-id="${safeMenuIdAttr}">
                    <span class="chapter-menu-id">${ch.menuId}</span>
                    <input type="text" class="chapter-name-input" value="${safeDisplay}" data-original="${safeOriginal}" data-menu-id="${safeMenuIdAttr}">
                    <label class="chapter-index-label">Segment index:</label>
                    <input type="number" class="chapter-index-input" min="1" value="${currentSegmentIndex}" data-menu-id="${safeMenuIdAttr}">
                    <button type="button" class="btn-section-save btn-chapter-save" onclick="saveChapterDisplayName('${lessonId.replace(/'/g, "\\'")}', '${menuIdEscaped}', this)">Save</button>
                </div>`;
        }).join('');

        container.style.display = 'block';
        setStatus(`Loaded ${chapters.length} chapters for ${lesson.name}`, 'success');
        setTimeout(() => setStatus('Ready'), 2000);
    } catch (error) {
        console.error('Error loading chapters:', error);
        editList.innerHTML = '<p class="chapters-empty">Error loading chapters: ' + (error.message || 'Unknown error') + '</p>';
        container.style.display = 'block';
        setStatus('Error loading chapters', 'error');
    }
}

async function saveChapterDisplayName(lessonId, menuId, btn) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }

    const row = document.querySelector(`#chapters-edit-list-${lessonId} .chapter-row[data-menu-id="${menuId}"]`);
    if (!row) return;
    const input = row.querySelector('.chapter-name-input');
    const indexInput = row.querySelector('.chapter-index-input');
    if (!input || !indexInput) return;

    setButtonLoading(btn, true);
    try {
        const newName = input.value.trim();
        const originalLabel = input.getAttribute('data-original') || '';
        const segmentIndexRaw = indexInput.value.trim();
        const segmentIndex = segmentIndexRaw ? parseInt(segmentIndexRaw, 10) : null;

        const lesson = lessonsData.find(l => l.lessonId === lessonId);
        if (!lesson) return;

        const metaRef = db.collection('lessonMetadata').doc(lessonId);

        // Update display name
        if (!newName || newName === originalLabel) {
            try {
                await metaRef.update({
                    [`chapterDisplayNames.${menuId}`]: firebase.firestore.FieldValue.delete()
                });
            } catch (e) {
                if (e.code !== 'not-found') throw e;
            }
            input.value = originalLabel;
            input.setAttribute('data-original', originalLabel);
        } else {
            const snap = await metaRef.get();
            const existing = (snap.exists && snap.data().chapterDisplayNames) ? { ...snap.data().chapterDisplayNames } : {};
            existing[menuId] = newName;
            await metaRef.set({ chapterDisplayNames: existing }, { merge: true });
            input.setAttribute('data-original', newName);
        }

        // Update chapter → segment index mapping
        if (segmentIndex && !Number.isNaN(segmentIndex) && segmentIndex > 0) {
            const snapIdx = await metaRef.get();
            const existingMap = (snapIdx.exists && snapIdx.data().chapterSegmentMap) ? { ...snapIdx.data().chapterSegmentMap } : {};
            existingMap[menuId] = segmentIndex;
            await metaRef.set({ chapterSegmentMap: existingMap }, { merge: true });
        }

        setStatus('Chapter mapping saved', 'success');
        setTimeout(() => setStatus('Ready'), 2000);
    } finally {
        setButtonLoading(btn, false);
    }
}

function adjustChapterIndexSequence(lessonId) {
    const editList = document.getElementById(`chapters-edit-list-${lessonId}`);
    if (!editList) return;
    const rows = editList.querySelectorAll('.chapter-row');
    rows.forEach((row, idx) => {
        const input = row.querySelector('.chapter-index-input');
        if (input) input.value = idx + 1;
    });
    setStatus('Indexes set to 1, 2, 3… — click Save all to persist', 'success');
    setTimeout(() => setStatus('Ready'), 2500);
}

async function saveAllChapters(lessonId, btn) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }
    const editList = document.getElementById(`chapters-edit-list-${lessonId}`);
    if (!editList) return;
    const rows = editList.querySelectorAll('.chapter-row');
    if (!rows.length) {
        setStatus('No chapters to save', 'error');
        return;
    }
    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (!lesson) return;

    setButtonLoading(btn, true);
    const metaRef = db.collection('lessonMetadata').doc(lessonId);
    setStatus('Saving all chapters...', 'scanning');

    const metaSnap = await metaRef.get();
    const existing = metaSnap.exists ? metaSnap.data() : {};
    const chapterDisplayNames = { ...(existing.chapterDisplayNames || {}) };
    const chapterSegmentMap = { ...(existing.chapterSegmentMap || {}) };
    const chapterMenuLabels = { ...(existing.chapterMenuLabels || {}) };
    const chapterOrder = [];

    for (const row of rows) {
        const menuId = row.getAttribute('data-menu-id');
        if (!menuId) continue;
        chapterOrder.push(menuId);
        const nameInput = row.querySelector('.chapter-name-input');
        const indexInput = row.querySelector('.chapter-index-input');
        const newName = nameInput ? nameInput.value.trim() : '';
        const originalLabel = nameInput ? (nameInput.getAttribute('data-original') || '') : '';
        const segmentIndexRaw = indexInput ? indexInput.value.trim() : '';
        const segmentIndex = segmentIndexRaw ? parseInt(segmentIndexRaw, 10) : null;

        if (originalLabel) {
            chapterMenuLabels[menuId] = originalLabel;
        }

        if (!newName || newName === originalLabel) {
            delete chapterDisplayNames[menuId];
            if (nameInput) {
                nameInput.setAttribute('data-original', originalLabel);
            }
        } else {
            chapterDisplayNames[menuId] = newName;
            if (nameInput) nameInput.setAttribute('data-original', newName);
        }
        if (segmentIndex != null && !Number.isNaN(segmentIndex) && segmentIndex > 0) {
            chapterSegmentMap[menuId] = segmentIndex;
        } else {
            delete chapterSegmentMap[menuId];
        }
    }

    try {
        await metaRef.set({
            chapterDisplayNames,
            chapterSegmentMap,
            chapterOrder,
            chapterMenuLabels,
        }, { merge: true });
        setStatus(`Saved ${rows.length} chapters`, 'success');
        setTimeout(() => setStatus('Ready'), 2000);
    } finally {
        setButtonLoading(btn, false);
    }
}

async function assignVideo(lessonId, btn) {
    try {
        requireAuth(); // Ensure user is authenticated
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }
    
    const selectElement = document.getElementById(`video-select-${lessonId}`);
    const buttonElement = btn || document.getElementById(`assign-btn-${lessonId}`);
    
    if (!selectElement || !selectElement.value) {
        alert('Please select a video first');
        return;
    }
    
    const selectedVideo = selectElement.value;
    const videoPath = `videos/${selectedVideo}`;
    
    setButtonLoading(buttonElement, true);
    try {
        // Update videoPaths collection with custom videoPath (not lessons collection)
        await db.collection('videoPaths').doc(lessonId).set({
            videoPath: videoPath
        }, { merge: true });
        
        // Update local data
        const lesson = lessonsData.find(l => l.lessonId === lessonId);
        if (lesson) {
            lesson.currentPath = videoPath;
            lesson.hasVideo = true; // Assume it exists since it's in the available videos list
            
            // Verify the video actually exists
            const videoCheck = await checkVideoAvailability(lessonId, videoPath);
            lesson.hasVideo = videoCheck.exists;
        }
        
        renderSidebarTree();
        displaySelectedLesson();
        // If this is the currently selected lesson, refresh the timeline editor too
        if (selectedLessonId === lessonId) {
            await refreshSrcArrayEditor();
        }
        updateVideosCountDisplay();
        
        const lessonName = lesson ? lesson.name : lessonId;
        setStatus(`Video assigned to ${lessonName}`, 'success');
        
        // Clear status after 3 seconds
        setTimeout(() => {
            setStatus('Ready');
        }, 3000);
    } catch (error) {
        console.error('Error assigning video:', error);
        alert('Error assigning video: ' + error.message);
    } finally {
        setButtonLoading(buttonElement, false);
        buttonElement.textContent = (lessonsData.find(l => l.lessonId === lessonId)?.hasVideo) ? 'Update' : 'Assign';
    }
}

// Reset lesson assignment back to its original/default video mapping and yellow-screen setting
async function resetLessonAssignment(lessonId, btn) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }

    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (!lesson) {
        setStatus('Lesson not found', 'error');
        return;
    }

    const confirmed = window.confirm(`Reset lesson "${lesson.name}" to its original video and yellow-screen settings?`);
    if (!confirmed) return;

    setButtonLoading(btn, true);
    setStatus(`Resetting ${lesson.name} to original settings...`, 'scanning');

    try {
        // Clear overrides in videoPaths (videoPath)
        const vpRef = db.collection('videoPaths').doc(lessonId);
        await vpRef.set({
            videoPath: firebase.firestore.FieldValue.delete()
        }, { merge: true });

        // Default path is videos/<lessonId>.mp4
        const defaultPath = `videos/${lessonId}.mp4`;
        const availability = await checkVideoAvailability(lessonId, null);

        lesson.currentPath = availability.exists ? defaultPath : '';
        lesson.hasVideo = availability.exists;

        renderSidebarTree();
        displaySelectedLesson();
        updateVideosCountDisplay();
        if (selectedLessonId === lessonId) {
            await refreshSrcArrayEditor();
        }

        setStatus(`Lesson reset to original settings`, 'success');
        setTimeout(() => setStatus('Ready'), 2500);
    } catch (error) {
        console.error('Error resetting lesson:', error);
        alert('Error resetting lesson: ' + error.message);
        setStatus('Error resetting lesson: ' + error.message, 'error');
    } finally {
        setButtonLoading(btn, false);
    }
}

// Regenerate srcArray for a lesson's video using yellow-screen detection (server-side)
async function regenerateSrcArrayFromYellow(lessonId, btn) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }

    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (!lesson) {
        setStatus('Lesson not found', 'error');
        return;
    }

    const confirmed = window.confirm(`Regenerate the srcArray for "${lesson.name}" from yellow-screen detections? This will overwrite the current timeline for this video.`);
    if (!confirmed) return;

    setButtonLoading(btn, true);
    setStatus(`Regenerating srcArray for ${lesson.name} from yellow screens...`, 'scanning');

    try {
        // Resolve video path and filename
        const videoPath = await getVideoPathForLesson(lessonId);
        if (!videoPath) throw new Error('No video path for this lesson');
        const detectYellow = functions.httpsCallable('detectYellowScreen', {
            timeout: 300000,
        });
        const result = await detectYellow({ videoPath, lessonId });
        const rd = result.data || {};

        if (!rd.success) {
            const msg = rd.message || rd.reason || 'Yellow detection found no events';
            const gLine = buildGreenSummaryLineFromResponse(rd.greenDetectionSummary);
            setStatus(`Regenerate skipped: ${msg}. Timeline unchanged.${gLine}`, 'error');
            if (selectedLessonId === lessonId) await refreshSrcArrayEditor();
            return;
        }

        // Reload the updated srcArray into the Timeline editor if this is the selected lesson
        if (selectedLessonId === lessonId) {
            await refreshSrcArrayEditor();
        }

        const rangesCount = Array.isArray(rd.yellowRanges) ? rd.yellowRanges.length : 0;
        const segs = typeof rd.adjustedSegments === 'number' ? rd.adjustedSegments : 'updated';
        const gLine = buildGreenSummaryLineFromResponse(rd.greenDetectionSummary);
        setStatus(`Regenerated from yellow: ${rangesCount} ranges detected, ${segs} segments in srcArray.${gLine}`, 'success');
        setTimeout(() => setStatus('Ready'), 3000);
    } catch (error) {
        console.error('Error regenerating srcArray from yellow:', error);
        alert('Error regenerating srcArray from yellow: ' + error.message);
        setStatus('Error regenerating srcArray from yellow: ' + error.message, 'error');
    } finally {
        setButtonLoading(btn, false);
    }
}

// Simple fallback (kept for backwards compatibility, currently unused)
function adjustSrcArraySimple(srcArray) {
    if (!srcArray || srcArray.length === 0) return srcArray;
    const adjusted = [];
    for (const segment of srcArray) {
        if (segment.src_start === null || segment.src_end === null) {
            adjusted.push(segment);
            continue;
        }
        const duration = segment.src_end - segment.src_start;
        if (adjusted.length === 0 && duration < 1.0) {
            continue;
        }
        adjusted.push(segment);
    }
    return adjusted;
}

// Extract menu links from lesson HTML file
async function extractMenuLinksFromHTML(lessonPath) {
    try {
        const response = await fetch(lessonPath);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${lessonPath}`);
        }
        const html = await response.text();
        
        // Parse HTML to extract menu buttons
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const menuLinks = [];
        const buttons = doc.querySelectorAll('button[id^="menu"]');
        
        buttons.forEach(button => {
            const menuId = button.getAttribute('id');
            const label = button.textContent.trim();
            if (menuId && label) {
                menuLinks.push({ menuId, label });
            }
        });
        
        // Sort by menu ID to ensure correct order (menu1, menu2, etc.)
        menuLinks.sort((a, b) => {
            const numA = parseInt(a.menuId.replace('menu', '')) || 0;
            const numB = parseInt(b.menuId.replace('menu', '')) || 0;
            return numA - numB;
        });
        
        return menuLinks;
    } catch (error) {
        console.error(`Error extracting menu links from ${lessonPath}:`, error);
        return [];
    }
}

// Extract currentSlide values from lesson JavaScript file
async function extractCurrentSlideFromJS(lessonPath) {
    try {
        // Ensure we're using the T version, not X version
        // Replace any X with T in the path if needed
        let normalizedPath = lessonPath;
        if (normalizedPath.includes('/LessonsX/')) {
            normalizedPath = normalizedPath.replace('/LessonsX/', '/LessonsT/');
        }
        if (normalizedPath.includes('X.html')) {
            normalizedPath = normalizedPath.replace('X.html', 'T.html');
        }
        
        // Determine JS file path - replace .html with .js
        let jsPath = normalizedPath.replace(/\.html$/, '.js');
        
        // Try to fetch the JS file
        let response = await fetch(jsPath);
        if (!response.ok) {
            // Try alternative path patterns
            const pathMatch = normalizedPath.match(/(.+T)\.html$/);
            if (pathMatch) {
                jsPath = pathMatch[1] + '.js';
                response = await fetch(jsPath);
            }
            if (!response.ok) {
                throw new Error(`Failed to fetch ${jsPath}`);
            }
        }
        
        const jsContent = await response.text();
        
        // Parse for menu click handlers: $('#menuX').on('click', function () { currentSlide = Y; });
        const menuToSlideMap = {};
        
        // Match patterns like: $('#menu1').on('click', function () { currentSlide = 0; });
        // Also handles cases with clickedLink = true; after currentSlide assignment
        // Pattern 1: Standard format with quotes
        const pattern1 = /\$\(['"]#menu(\d+)['"]\)\.on\(['"]click['"],\s*function\s*\(\)\s*\{\s*currentSlide\s*=\s*(\d+);/g;
        let match;
        
        while ((match = pattern1.exec(jsContent)) !== null) {
            const menuId = `menu${match[1]}`;
            const currentSlide = parseInt(match[2], 10);
            menuToSlideMap[menuId] = currentSlide;
        }
        
        // Pattern 2: More flexible pattern to catch any variations
        // Matches: #menu1 ... currentSlide = 0
        const pattern2 = /#menu(\d+)[^}]*?currentSlide\s*=\s*(\d+)/g;
        let match2;
        while ((match2 = pattern2.exec(jsContent)) !== null) {
            const menuId = `menu${match2[1]}`;
            const currentSlide = parseInt(match2[2], 10);
            // Only add if not already found (pattern1 takes precedence)
            if (!menuToSlideMap[menuId]) {
                menuToSlideMap[menuId] = currentSlide;
            }
        }
        
        return menuToSlideMap;
    } catch (error) {
        console.error(`Error extracting currentSlide from JS for ${lessonPath}:`, error);
        return {};
    }
}

// Map segment links to srcArray menuLink property
async function mapSegmentLinksToSrcArray(lessonId) {
    try {
        // Get lesson data from lessonsData
        const lesson = lessonsData.find(l => l.lessonId === lessonId);
        if (!lesson) {
            throw new Error(`Lesson not found: ${lessonId}`);
        }
        
        // Timeline is keyed by lessonId
        const lessonDoc = await db.collection('lessons').doc(lessonId).get();
        if (!lessonDoc.exists) {
            throw new Error(`Lesson timeline not found: ${lessonId}`);
        }
        const srcArray = (lessonDoc.data().srcArray) || [];
        if (srcArray.length === 0) {
            throw new Error(`srcArray is empty for lesson: ${lessonId}`);
        }
        
        // Extract menu links from HTML
        const menuLinks = await extractMenuLinksFromHTML(lesson.path);
        if (menuLinks.length === 0) {
            return { mapped: 0, skipped: true, reason: 'No menu links found' };
        }
        
        // Extract currentSlide mappings from JS
        const menuToSlideMap = await extractCurrentSlideFromJS(lesson.path);
        if (Object.keys(menuToSlideMap).length === 0) {
            return { mapped: 0, skipped: true, reason: 'No currentSlide mappings found' };
        }
        
        // Count available segments (excluding opening segment)
        const availableSegments = srcArray.filter(seg => seg.src_start !== null && seg.src_end !== null).length;
        
        // Count segment links (menu links that have currentSlide mappings)
        const segmentLinks = menuLinks.filter(link => menuToSlideMap.hasOwnProperty(link.menuId));
        
        // Check if too many segment links
        if (segmentLinks.length > availableSegments) {
            return { 
                mapped: 0, 
                skipped: true, 
                reason: `Too many segment links (${segmentLinks.length}) for available segments (${availableSegments})` 
            };
        }
        
        // Create a copy of srcArray to modify
        const updatedSrcArray = [...srcArray];
        let mappedCount = 0;
        
        // Map menuLink values to srcArray segments
        for (const menuLink of segmentLinks) {
            const currentSlide = menuToSlideMap[menuLink.menuId];
            
            // currentSlide corresponds to the index in srcArray (0-based)
            // Skip opening segment (index 0) as it already has a menuLink
            if (currentSlide > 0 && currentSlide < updatedSrcArray.length) {
                const segment = updatedSrcArray[currentSlide];
                
                // Only map if menuLink is empty or null
                if (!segment.menuLink || segment.menuLink === '') {
                    segment.menuLink = menuLink.label;
                    mappedCount++;
                }
            }
        }
        
        // Update Firestore if any mappings were made (timeline keyed by lessonId)
        if (mappedCount > 0) {
            await db.collection('lessons').doc(lessonId).set({
                srcArray: updatedSrcArray
            }, { merge: true });
        }
        return { mapped: mappedCount, skipped: false };
    } catch (error) {
        console.error(`Error mapping segment links for ${lessonId}:`, error);
        return { mapped: 0, skipped: true, reason: error.message };
    }
}

// Main function to map all segment links
async function mapAllSegmentLinks() {
    try {
        requireAuth(); // Ensure user is authenticated
    } catch (error) {
        setStatus('Authentication required', 'error');
        return;
    }
    
    if (lessonsData.length === 0) {
        setStatus('Please scan lessons first', 'error');
        return;
    }
    
    setStatus('Mapping segment links...', 'scanning');
    if (mapSegmentLinksBtn) {
        mapSegmentLinksBtn.disabled = true;
    }
    
    let totalMapped = 0;
    let totalSkipped = 0;
    const skippedLessons = [];
    
    try {
        for (let i = 0; i < lessonsData.length; i++) {
            const lesson = lessonsData[i];
            setStatus(`Mapping segment links (${i + 1}/${lessonsData.length}): ${lesson.name}...`, 'scanning');
            
            const result = await mapSegmentLinksToSrcArray(lesson.lessonId);
            
            if (result.skipped) {
                totalSkipped++;
                skippedLessons.push({
                    name: lesson.name,
                    reason: result.reason || 'Unknown reason'
                });
            } else {
                totalMapped += result.mapped;
            }
        }
        
        const statusMsg = `Mapping complete: ${totalMapped} links mapped, ${totalSkipped} lessons skipped`;
        setStatus(statusMsg, totalMapped > 0 ? 'success' : 'error');
        
        if (skippedLessons.length > 0) {
            console.log('Skipped lessons:', skippedLessons);
        }
    } catch (error) {
        console.error('Error mapping segment links:', error);
        setStatus('Error mapping segment links: ' + error.message, 'error');
    } finally {
        if (mapSegmentLinksBtn) {
            mapSegmentLinksBtn.disabled = false;
        }
    }
}

// Detect video titles using OCR for a single lesson
async function detectVideoTitlesForLesson(lessonId) {
    try {
        // Get lesson data from lessonsData
        const lesson = lessonsData.find(l => l.lessonId === lessonId);
        if (!lesson) {
            throw new Error(`Lesson not found: ${lessonId}`);
        }
        
        const videoPath = await getVideoPathForLesson(lessonId);
        if (!videoPath) {
            throw new Error(`Video path not found for lesson: ${lessonId}`);
        }
        const lessonDoc = await db.collection('lessons').doc(lessonId).get();
        if (!lessonDoc.exists || !(lessonDoc.data().srcArray || []).length) {
            return { success: false, skipped: true, reason: 'Lesson timeline not found or srcArray empty' };
        }
        const menuLinks = await extractMenuLinksFromHTML(lesson.path);
        const segmentLinks = menuLinks.map(link => ({ label: link.label }));
        const detectVideoTitlesFunction = functions.httpsCallable('detectVideoTitles', {
            timeout: 540000,
        });
        const result = await detectVideoTitlesFunction({
            videoPath,
            lessonId,
            segmentLinks
        });
        
        return {
            success: true,
            skipped: false,
            detectedTitles: result.data.detectedTitles,
            refinedSegments: result.data.refinedSegments,
            assignedMenuLinks: result.data.assignedMenuLinks
        };
    } catch (error) {
        console.error(`Error detecting video titles for ${lessonId}:`, error);
        return { 
            success: false, 
            skipped: true, 
            reason: error.message 
        };
    }
}

// Generate a chapter-aware srcArray using yellow screens in order
async function generateSrcArrayFromYellowScreensForLesson(lessonId) {
    try {
        requireAuth();
    } catch (error) {
        setStatus('Authentication required', 'error');
        return;
    }

    if (!lessonId) {
        setStatus('Select a lesson first', 'error');
        return;
    }

    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (!lesson) {
        setStatus('Lesson not found', 'error');
        return;
    }

    try {
        // Get videoPath from videoPaths collection
        const videoPathDoc = await db.collection('videoPaths').doc(lessonId).get();
        if (!videoPathDoc.exists || !videoPathDoc.data().videoPath) {
            setStatus('No videoPath found for this lesson', 'error');
            return;
        }
        const videoPath = videoPathDoc.data().videoPath;
        const menuLinks = await extractMenuLinksFromHTML(lesson.path);
        if (!menuLinks.length) {
            setStatus('No chapters found for this lesson', 'error');
            return;
        }
        const chapters = menuLinks.map(link => link.label);
        setStatus('Generating timeline from yellow screens...', 'scanning');
        const generateFn = functions.httpsCallable('generateSrcArrayFromYellowScreens', {
            timeout: 300000,
        });
        const result = await generateFn({
            videoPath,
            lessonId,
            chapters
        });

        const data = result.data || {};
        if (data.success === false) {
            const msg = data.message || data.reason || 'Generation failed';
            const gLine = buildGreenSummaryLineFromResponse(data.greenDetectionSummary);
            setStatus(`Auto-generate failed: ${msg}. Timeline unchanged.${gLine}`, 'error');
        } else {
            const segs = data.segments || 0;
            const gLine = buildGreenSummaryLineFromResponse(data.greenDetectionSummary);
            setStatus(`Generated ${segs} segments from yellow screens.${gLine}`, data.status === 'ok' ? 'success' : 'scanning');
        }

        // Refresh the srcArray editor so the new timeline is visible
        await refreshSrcArrayEditor();
    } catch (error) {
        console.error('Error generating srcArray from yellow screens:', error);
        setStatus('Error generating timeline: ' + error.message, 'error');
    }
}

// Main function to detect video titles for all lessons
async function detectVideoTitlesForAllLessons() {
    try {
        requireAuth(); // Ensure user is authenticated
    } catch (error) {
        setStatus('Authentication required', 'error');
        return;
    }
    
    if (lessonsData.length === 0) {
        setStatus('Please scan lessons first', 'error');
        return;
    }
    
    setStatus('Detecting video titles...', 'scanning');
    if (detectVideoTitlesBtn) {
        detectVideoTitlesBtn.disabled = true;
    }
    
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalRefined = 0;
    let totalAssigned = 0;
    const skippedLessons = [];
    
    try {
        for (let i = 0; i < lessonsData.length; i++) {
            const lesson = lessonsData[i];
            setStatus(`Detecting titles (${i + 1}/${lessonsData.length}): ${lesson.name}...`, 'scanning');
            
            const result = await detectVideoTitlesForLesson(lesson.lessonId);
            
            if (result.skipped) {
                totalSkipped++;
                skippedLessons.push({
                    name: lesson.name,
                    reason: result.reason || 'Unknown reason'
                });
            } else {
                totalProcessed++;
                totalRefined += result.refinedSegments || 0;
                totalAssigned += result.assignedMenuLinks || 0;
            }
        }
        
        const statusMsg = `Title detection complete: ${totalProcessed} processed, ${totalRefined} segments refined, ${totalAssigned} menuLinks assigned, ${totalSkipped} skipped`;
        setStatus(statusMsg, totalProcessed > 0 ? 'success' : 'error');
        
        if (skippedLessons.length > 0) {
            console.log('Skipped lessons:', skippedLessons);
        }
    } catch (error) {
        console.error('Error detecting video titles:', error);
        setStatus('Error detecting video titles: ' + error.message, 'error');
    } finally {
        if (detectVideoTitlesBtn) {
            detectVideoTitlesBtn.disabled = false;
        }
    }
}

// Make functions available globally
window.assignVideo = assignVideo;
window.toggleYellowScreen = toggleYellowScreen;
window.saveLessonMetadata = saveLessonMetadata;
window.showChaptersForLesson = showChaptersForLesson;
window.saveChapterDisplayName = saveChapterDisplayName;
window.adjustChapterIndexSequence = adjustChapterIndexSequence;
window.saveAllChapters = saveAllChapters;
window.resetLessonAssignment = resetLessonAssignment;
async function saveLessonPlaybackSettings(lessonId, btn) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }
    const cb = document.getElementById(`forceChapterStartZero-${lessonId}`);
    const enabled = !!(cb && cb.checked);
    if (btn) setButtonLoading(btn, true);
    try {
        await db.collection('lessons').doc(lessonId).set(
            { forceFirstChapterStartAtZero: enabled },
            { merge: true }
        );
        setStatus(
            enabled
                ? 'First chapter will start at 0:00 for this lesson'
                : 'First chapter uses mapped timeline start again',
            'success'
        );
        setTimeout(() => setStatus('Ready'), 2500);
    } catch (err) {
        console.error('saveLessonPlaybackSettings failed:', err);
        setStatus('Failed to save playback settings: ' + err.message, 'error');
    } finally {
        if (btn) setButtonLoading(btn, false);
    }
}

window.saveLessonPlaybackSettings = saveLessonPlaybackSettings;
window.regenerateSrcArrayFromYellow = regenerateSrcArrayFromYellow;
window.saveSectionDisplayName = async function saveSectionDisplayName(originalSection, btn) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }

    const inputId = `section-index-input-${originalSection.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const inputEl = document.getElementById(inputId);
    if (!inputEl) {
        alert('Unable to find section input.');
        return;
    }

    const newName = inputEl.value.trim();

    // Find any lesson from this original section to compare effective name
    const anyLesson = lessonsData.find(l => l.originalSection === originalSection);
    const currentEffective = anyLesson ? anyLesson.section : originalSection;
    const hasChange = newName !== currentEffective;

    if (!hasChange) {
        setStatus('No section changes to save', 'success');
        setTimeout(() => setStatus('Ready'), 2000);
        return;
    }

    setButtonLoading(btn, true);
    inputEl.disabled = true;

    try {
        const sectionDocRef = db.collection('sectionNames').doc(originalSection);
        if (!newName || newName === originalSection) {
            await sectionDocRef.set(
                { displayName: firebase.firestore.FieldValue.delete() },
                { merge: true }
            );
        } else {
            await sectionDocRef.set(
                { displayName: newName },
                { merge: true }
            );
        }

        // Update local lessonsData
        const effectiveSectionName =
            !newName || newName === originalSection ? originalSection : newName;

        lessonsData.forEach(l => {
            if (l.originalSection === originalSection) {
                l.section = effectiveSectionName;
            }
        });

        renderSidebarTree();
        displaySelectedLesson();
        setStatus('Section name saved', 'success');
        setTimeout(() => setStatus('Ready'), 3000);
    } catch (error) {
        console.error('Error saving section display name:', error);
        alert('Error saving section display name: ' + error.message);
    } finally {
        inputEl.disabled = false;
        setButtonLoading(btn, false);
    }
};
window.scrollToLesson = function scrollToLesson(lessonId) {
    selectLesson(lessonId);
};

