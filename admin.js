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
let loginScreen, dashboardScreen, loginForm, scanBtn, refreshVideosBtn, statusText, loginError, videosList;
let uploadVideoBtn, uploadVideoInput;
let instructionsBtn, changelogBtn, instructionsModal, changelogModal;
let profileBtn, profileModal;
let searchInput, filterButtons;
let currentFilter = 'all';
let searchQuery = '';
let selectedLessonId = null;
let collapsedSections = new Set();
/** Current srcArray and video doc id for the Timeline editor (so Save all knows where to write) */
let currentSrcArrayForEditor = [];
let currentSrcArrayVideoFilename = null;

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
    scanBtn = document.getElementById('scanBtn');
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

    // Scan Lessons
    if (scanBtn) {
        scanBtn.addEventListener('click', async () => {
            await scanLessons();
        });
    }

    // Refresh Videos
    if (refreshVideosBtn) {
        refreshVideosBtn.addEventListener('click', async () => {
            await loadAvailableVideos();
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
                    await fileRef.put(file);
                }

                setStatus('Upload complete. Refreshing video list...', 'success');
                await loadAvailableVideos();
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
            <span class="video-item-name">${esc}</span>
            <span class="video-item-meta"><span class="video-item-size" data-video="${esc}">—</span> · <span class="video-item-duration" data-video="${esc}">—:—</span></span>
            <span class="video-item-play" aria-label="Play"><svg class="heroicon heroicon-play" width="18" height="18" aria-hidden="true"><use href="#icon-play"/></svg></span>
        </div>`;
    }).join('');

    videosList.querySelectorAll('.video-item').forEach(el => {
        el.addEventListener('click', () => openVideoPreview(el.getAttribute('data-video')));
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
        player.play().catch(() => {});
    } catch (e) {
        console.error('Error loading video:', e);
        setStatus('Could not load video for preview', 'error');
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
    scanBtn.disabled = true;
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
                    // Check videoPaths collection for custom videoPath and yellowScreen setting
                    const videoPathDoc = await db.collection('videoPaths').doc(lesson.lessonId).get();
                    const videoPathData = videoPathDoc.exists ? videoPathDoc.data() : {};
                    const customVideoPath = videoPathData.videoPath || null;
                    const yellowScreen = videoPathData.yellowScreen !== undefined ? videoPathData.yellowScreen : true; // Default to true
                    
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
                        error: videoCheck.error,
                        yellowScreen: yellowScreen
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
        scanBtn.disabled = false;
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
                const status = lesson.hasVideo ? '●' : '○';
                const statusClass = lesson.hasVideo ? 'has-video' : 'missing';
                const escId = lesson.lessonId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                return `<div class="tree-lesson ${statusClass}" data-lesson-id="${lesson.lessonId}" onclick="selectLesson('${escId}')"><span class="tree-lesson-status">${status}</span><span class="tree-lesson-name">${safeLessonName}</span></div>`;
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
                    <button type="button" class="btn-section-save" onclick="saveSectionDisplayName('${section.originalSection.replace(/'/g, "\\'")}')">Save</button>
                </div>
                <div class="tree-section-children">${lessonRows}</div>
            </div>`;
    }).join('');
    treeEl.innerHTML = html;
}

function displaySelectedLesson() {
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
    panel.innerHTML = getLessonCardHTML(lesson);
}

function getLessonCardHTML(lesson) {
    const statusClass = lesson.hasVideo ? 'has-video' : 'missing';
    const statusText = lesson.hasVideo ? 'Has Video' : 'Missing';
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
                    <button class="btn-metadata-save" onclick="saveLessonMetadata('${escId}')">Save Lesson Name</button>
                </div>
                <div class="assignment-row">
                    <select id="video-select-${lesson.lessonId}">
                        <option value="">${lesson.hasVideo ? 'Change video...' : 'Select a video...'}</option>
                        ${videoOptions}
                    </select>
                    <button onclick="assignVideo('${escId}')" id="assign-btn-${lesson.lessonId}">${lesson.hasVideo ? 'Update' : 'Assign'}</button>
                </div>
                <div class="yellow-screen-option">
                    <label>
                        <input type="checkbox" id="yellow-screen-${lesson.lessonId}" ${lesson.yellowScreen ? 'checked' : ''} onchange="toggleYellowScreen('${escId}')">
                        Remove yellow screen (adjust srcArray)
                    </label>
                </div>
                <div class="lesson-chapters-block">
                    <button type="button" class="btn btn-secondary btn-chapters" onclick="showChaptersForLesson('${escId}')"><span class="btn-label">Show chapters</span></button>
                    <div id="chapters-container-${lesson.lessonId}" class="chapters-container" style="display:none;">
                        <label class="chapters-dropdown-label">Chapters</label>
                        <select id="chapters-dropdown-${lesson.lessonId}" class="chapters-dropdown"><option value="">— Select a chapter —</option></select>
                        <div id="chapters-edit-list-${lesson.lessonId}" class="chapters-edit-list"></div>
                    </div>
                </div>
            </div>
        </div>`;
}

function selectLesson(lessonId) {
    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (lesson) collapsedSections.delete(lesson.originalSection);
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

/** Get video filename (no extension) for the selected lesson's video doc in Firestore */
async function getVideoFilenameForLesson(lessonId) {
    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (!lesson) return null;
    const videoPathDoc = await db.collection('videoPaths').doc(lessonId).get();
    const videoPath = videoPathDoc.exists && videoPathDoc.data().videoPath
        ? videoPathDoc.data().videoPath
        : `videos/${lessonId}.mp4`;
    const match = videoPath.match(/videos\/([^/]+)\.mp4$/);
    return match ? match[1] : null;
}

/** Load srcArray from Firestore for the Timeline editor */
async function loadSrcArrayForEditor(lessonId) {
    const videoFilename = await getVideoFilenameForLesson(lessonId);
    if (!videoFilename) return { videoFilename: null, srcArray: [] };
    const videoDoc = await db.collection('lessons').doc(videoFilename).get();
    const srcArray = (videoDoc.exists && videoDoc.data().srcArray) ? videoDoc.data().srcArray : [];
    return { videoFilename, srcArray };
}

function renderSrcArrayTable(srcArray, videoFilename) {
    const tbody = document.getElementById('srcArrayEditorTbody');
    const tableWrap = document.querySelector('.srcarray-editor-table-wrap');
    const emptyEl = document.getElementById('srcArrayEditorEmpty');
    if (!tbody || !tableWrap || !emptyEl) return;

    currentSrcArrayForEditor = Array.isArray(srcArray) ? srcArray.map(s => ({ ...s })) : [];
    currentSrcArrayVideoFilename = videoFilename;

    if (currentSrcArrayForEditor.length === 0) {
        tbody.innerHTML = '';
        tableWrap.style.display = 'none';
        emptyEl.style.display = 'block';
        return;
    }

    tableWrap.style.display = 'block';
    emptyEl.style.display = 'none';

    const rows = currentSrcArrayForEditor.map((seg, index) => {
        const start = seg.src_start != null ? Number(seg.src_start) : '';
        const end = seg.src_end != null ? Number(seg.src_end) : '';
        const menuLink = (seg.menuLink != null ? String(seg.menuLink) : '').replace(/"/g, '&quot;');
        const title = (seg.title != null ? String(seg.title) : '').replace(/"/g, '&quot;');
        const confidence = (seg.confidence != null ? String(seg.confidence) : '').replace(/"/g, '&quot;');
        return `<tr data-index="${index}">
            <td class="srcarray-col-index">${index}</td>
            <td><input type="number" step="0.01" class="srcarray-input-start" value="${start}" data-index="${index}"></td>
            <td><input type="number" step="0.01" class="srcarray-input-end" value="${end}" data-index="${index}"></td>
            <td><input type="text" class="srcarray-input-menuLink" value="${menuLink}" data-index="${index}" placeholder="chapter / menu"></td>
            <td><input type="text" class="srcarray-input-title" value="${title}" data-index="${index}" placeholder="source label"></td>
            <td><input type="text" class="srcarray-input-confidence" value="${confidence}" data-index="${index}" placeholder="—"></td>
            <td class="srcarray-col-actions"></td>
        </tr>`;
    }).join('');
    tbody.innerHTML = rows;
}

async function refreshSrcArrayEditor() {
    const statusEl = document.getElementById('srcArrayEditorStatus');
    if (!selectedLessonId) {
        currentSrcArrayForEditor = [];
        currentSrcArrayVideoFilename = null;
        renderSrcArrayTable([], null);
        if (statusEl) statusEl.textContent = '';
        return;
    }
    if (statusEl) statusEl.textContent = 'Loading…';
    try {
        const { videoFilename, srcArray } = await loadSrcArrayForEditor(selectedLessonId);
        renderSrcArrayTable(srcArray, videoFilename);
        if (statusEl) statusEl.textContent = videoFilename ? `${srcArray.length} segments` : 'No video assigned';
    } catch (e) {
        console.error('refreshSrcArrayEditor:', e);
        renderSrcArrayTable([], null);
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
    const syncBtn = document.getElementById('srcArraySyncChaptersBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', async () => {
            if (!selectedLessonId) {
                setStatus('Select a lesson first', 'error');
                return;
            }
            setStatus('Syncing from chapters…', 'scanning');
            try {
                const result = await mapSegmentLinksForLesson(selectedLessonId);
                if (result.skipped) {
                    setStatus(result.reason || 'Skipped', 'error');
                } else {
                    setStatus(`Mapped ${result.mapped} segment links`, 'success');
                    await refreshSrcArrayEditor();
                }
            } catch (e) {
                setStatus('Sync failed: ' + e.message, 'error');
            }
        });
    }
    const saveBtn = document.getElementById('srcArraySaveAllBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            if (!currentSrcArrayVideoFilename || currentSrcArrayForEditor.length === 0) {
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
                const titleInput = row.querySelector('.srcarray-input-title');
                const confidenceInput = row.querySelector('.srcarray-input-confidence');
                if (startInput) seg.src_start = startInput.value === '' ? null : parseFloat(startInput.value);
                if (endInput) seg.src_end = endInput.value === '' ? null : parseFloat(endInput.value);
                if (menuLinkInput) seg.menuLink = menuLinkInput.value.trim() || '';
                if (titleInput) seg.title = titleInput.value.trim() || '';
                if (confidenceInput) seg.confidence = confidenceInput.value.trim() || '';
                updated.push(seg);
            }
            setStatus('Saving timeline…', 'scanning');
            try {
                await db.collection('lessons').doc(currentSrcArrayVideoFilename).set({ srcArray: updated }, { merge: true });
                currentSrcArrayForEditor = updated;
                setStatus('Timeline saved', 'success');
                const statusEl = document.getElementById('srcArrayEditorStatus');
                if (statusEl) statusEl.textContent = `${updated.length} segments saved`;
            } catch (e) {
                setStatus('Save failed: ' + e.message, 'error');
            }
        });
    }
    const autoBtn = document.getElementById('srcArrayAutoGenerateBtn');
    if (autoBtn) {
        autoBtn.addEventListener('click', async () => {
            if (!selectedLessonId) {
                setStatus('Select a lesson first', 'error');
                return;
            }
            await generateSrcArrayFromYellowScreensForLesson(selectedLessonId);
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

async function saveLessonMetadata(lessonId) {
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
    const dropdown = document.getElementById(`chapters-dropdown-${lessonId}`);
    const editList = document.getElementById(`chapters-edit-list-${lessonId}`);
    if (!container || !dropdown || !editList) return;

    setStatus('Detecting chapters from lesson...', 'scanning');

    try {
        const menuLinks = await extractMenuLinksFromHTML(lesson.path);
        if (!menuLinks.length) {
            editList.innerHTML = '<p class="chapters-empty">No chapter buttons found in this lesson.</p>';
            dropdown.innerHTML = '<option value="">— No chapters —</option>';
            container.style.display = 'block';
            setStatus('No chapters detected', 'error');
            return;
        }

        const metaDoc = await db.collection('lessonMetadata').doc(lessonId).get();
        const chapterDisplayNames = (metaDoc.exists && metaDoc.data().chapterDisplayNames) ? metaDoc.data().chapterDisplayNames : {};

        const chapters = menuLinks.map(m => ({
            menuId: m.menuId,
            originalLabel: m.label,
            displayName: chapterDisplayNames[m.menuId] !== undefined ? chapterDisplayNames[m.menuId] : m.label
        }));

        dropdown.innerHTML = '<option value="">— Select a chapter —</option>' +
            chapters.map((ch, i) => {
                const safe = ch.displayName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<option value="${i}">${safe}</option>`;
            }).join('');

        editList.innerHTML = chapters.map((ch) => {
            const safeOriginal = ch.originalLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const safeDisplay = ch.displayName.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const safeMenuIdAttr = ch.menuId.replace(/"/g, '&quot;');
            const menuIdEscaped = ch.menuId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return `
                <div class="chapter-row" data-menu-id="${safeMenuIdAttr}">
                    <span class="chapter-menu-id">${ch.menuId}</span>
                    <input type="text" class="chapter-name-input" value="${safeDisplay}" data-original="${safeOriginal}" data-menu-id="${safeMenuIdAttr}">
                    <button type="button" class="btn-section-save btn-chapter-save" onclick="saveChapterDisplayName('${lessonId.replace(/'/g, "\\'")}', '${menuIdEscaped}')">Save</button>
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

async function saveChapterDisplayName(lessonId, menuId) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }

    const row = document.querySelector(`#chapters-edit-list-${lessonId} .chapter-row[data-menu-id="${menuId}"]`);
    const input = row ? row.querySelector('.chapter-name-input') : null;
    if (!input) return;

    const newName = input.value.trim();
    const originalLabel = input.getAttribute('data-original') || '';

    const lesson = lessonsData.find(l => l.lessonId === lessonId);
    if (!lesson) return;

    const metaRef = db.collection('lessonMetadata').doc(lessonId);

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
    const dropdown = document.getElementById(`chapters-dropdown-${lessonId}`);
    if (dropdown) {
        const rows = document.querySelectorAll(`#chapters-edit-list-${lessonId} .chapter-row`);
        const options = dropdown.querySelectorAll('option');
        options.forEach((opt) => {
            if (opt.value === '') return;
            const rowIndex = parseInt(opt.value, 10);
            const row = rows[rowIndex];
            const inp = row ? row.querySelector('.chapter-name-input') : null;
            if (inp) opt.textContent = inp.value.trim() || inp.getAttribute('data-original') || '';
        });
    }
    setStatus('Chapter name saved', 'success');
    setTimeout(() => setStatus('Ready'), 2000);
}

async function assignVideo(lessonId) {
    try {
        requireAuth(); // Ensure user is authenticated
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }
    
    const selectElement = document.getElementById(`video-select-${lessonId}`);
    const buttonElement = document.getElementById(`assign-btn-${lessonId}`);
    
    if (!selectElement || !selectElement.value) {
        alert('Please select a video first');
        return;
    }
    
    const selectedVideo = selectElement.value;
    const videoPath = `videos/${selectedVideo}`;
    
    buttonElement.disabled = true;
    buttonElement.textContent = 'Assigning...';
    
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
        buttonElement.disabled = false;
        const lesson = lessonsData.find(l => l.lessonId === lessonId);
        buttonElement.textContent = (lesson && lesson.hasVideo) ? 'Update' : 'Assign';
    }
}

// Toggle yellow screen setting
async function toggleYellowScreen(lessonId) {
    try {
        requireAuth();
    } catch (error) {
        alert('Authentication required. Please log in again.');
        return;
    }
    
    const checkbox = document.getElementById(`yellow-screen-${lessonId}`);
    if (!checkbox) return;
    
    const yellowScreen = checkbox.checked;
    const previousState = !yellowScreen; // Previous state (before toggle)
    
    try {
        // Get videoPath from videoPaths collection
        const videoPathDoc = await db.collection('videoPaths').doc(lessonId).get();
        if (!videoPathDoc.exists) {
            throw new Error('Video path not found for this lesson');
        }
        
        const videoPathData = videoPathDoc.data();
        const videoPath = videoPathData.videoPath || `videos/${lessonId}.mp4`;
        
        // Extract video filename from videoPath (e.g., "videos/filename.mp4" → "filename")
        const match = videoPath.match(/videos\/([^\/]+)\.mp4$/);
        if (!match) {
            throw new Error('Invalid video path format');
        }
        const videoFilename = match[1]; // Video filename without extension
        
        // Get current srcArray from lessons collection
        const videoDoc = await db.collection('lessons').doc(videoFilename).get();
        if (!videoDoc.exists) {
            throw new Error(`Video document not found: ${videoFilename}`);
        }
        
        const videoData = videoDoc.data();
        const currentSrcArray = videoData.srcArray || [];
        const originalSrcArray = videoData.originalSrcArray || currentSrcArray;
        let updatedSrcArray = currentSrcArray;
        
        if (!yellowScreen) {
            // User wants to REMOVE yellow screen - need to detect and adjust
            setStatus('Detecting yellow screen frames...', 'scanning');
            checkbox.disabled = true;
            
            try {
                // Call Cloud Function to detect yellow screens and adjust srcArray
                const detectYellowScreen = functions.httpsCallable('detectYellowScreen');
                const result = await detectYellowScreen({
                    videoPath: videoPath,
                    videoFilename: videoFilename
                });
                
                if (result.data.success) {
                    // Cloud Function has already updated the srcArray in Firestore
                    // Get the updated srcArray
                    const updatedDoc = await db.collection('lessons').doc(videoFilename).get();
                    updatedSrcArray = updatedDoc.data().srcArray || currentSrcArray;
                    
                    setStatus(`Yellow screen removed: ${result.data.yellowRanges.length} ranges detected, ${result.data.adjustedSegments} segments adjusted`, 'success');
                } else {
                    throw new Error('Yellow screen detection failed');
                }
            } catch (error) {
                console.error('Error calling yellow screen detection:', error);
                // Fallback to simple heuristic if Cloud Function fails
                setStatus('Using fallback method to remove yellow screen...', 'scanning');
                updatedSrcArray = adjustSrcArraySimple(currentSrcArray);
            }
        } else {
            // User wants to RESTORE yellow screen - use original srcArray
            // Restore original srcArray if it exists
            if (originalSrcArray && originalSrcArray.length > 0) {
                updatedSrcArray = originalSrcArray;
                setStatus('Restoring original srcArray with yellow screens...', 'scanning');
            } else {
                // No original stored, can't restore
                setStatus('Original srcArray not found, cannot restore yellow screens', 'error');
                checkbox.checked = false; // Revert checkbox
                return;
            }
        }
        
        // Update the VIDEO's document in lessons collection with modified srcArray
        await db.collection('lessons').doc(videoFilename).set({
            srcArray: updatedSrcArray,
            originalSrcArray: originalSrcArray // Ensure original is stored
        }, { merge: true });
        
        // Store yellowScreen preference in videoPaths collection
        await db.collection('videoPaths').doc(lessonId).set({
            yellowScreen: yellowScreen
        }, { merge: true });
        
        // Update local data
        const lesson = lessonsData.find(l => l.lessonId === lessonId);
        if (lesson) {
            lesson.yellowScreen = yellowScreen;
        }
        
        if (yellowScreen) {
            setStatus(`Yellow screen restored for ${lesson ? lesson.name : lessonId}`, 'success');
        }
        
        setTimeout(() => {
            setStatus('Ready');
        }, 3000);
    } catch (error) {
        console.error('Error toggling yellow screen:', error);
        alert('Error updating yellow screen setting: ' + error.message);
        checkbox.checked = previousState; // Revert checkbox
    } finally {
        checkbox.disabled = false;
    }
}

// Simple fallback method to adjust srcArray (removes very short initial segments)
function adjustSrcArraySimple(srcArray) {
    if (!srcArray || srcArray.length === 0) return srcArray;
    
    const adjusted = [];
    
    for (const segment of srcArray) {
        // Keep opening segment
        if (segment.src_start === null || segment.src_end === null) {
            adjusted.push(segment);
            continue;
        }
        
        // Remove very short segments at the start (likely yellow screens)
        const duration = segment.src_end - segment.src_start;
        if (adjusted.length === 0 && duration < 1.0) {
            // Skip first very short segment
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
        
        // Get video filename from videoPaths collection
        const videoPathDoc = await db.collection('videoPaths').doc(lessonId).get();
        if (!videoPathDoc.exists) {
            throw new Error(`Video path not found for lesson: ${lessonId}`);
        }
        
        const videoPathData = videoPathDoc.data();
        const videoPath = videoPathData.videoPath || `videos/${lessonId}.mp4`;
        
        // Extract video filename (without extension)
        const match = videoPath.match(/videos\/([^\/]+)\.mp4$/);
        if (!match) {
            throw new Error(`Invalid video path format: ${videoPath}`);
        }
        const videoFilename = match[1];
        
        // Get srcArray from Firestore
        const videoDoc = await db.collection('lessons').doc(videoFilename).get();
        if (!videoDoc.exists) {
            throw new Error(`Video document not found: ${videoFilename}`);
        }
        
        const videoData = videoDoc.data();
        const srcArray = videoData.srcArray || [];
        
        if (srcArray.length === 0) {
            throw new Error(`srcArray is empty for video: ${videoFilename}`);
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
        
        // Update Firestore if any mappings were made
        if (mappedCount > 0) {
            await db.collection('lessons').doc(videoFilename).set({
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
        
        // Get video filename from videoPaths collection
        const videoPathDoc = await db.collection('videoPaths').doc(lessonId).get();
        if (!videoPathDoc.exists) {
            throw new Error(`Video path not found for lesson: ${lessonId}`);
        }
        
        const videoPathData = videoPathDoc.data();
        const videoPath = videoPathData.videoPath || `videos/${lessonId}.mp4`;
        
        // Extract video filename (without extension)
        const match = videoPath.match(/videos\/([^\/]+)\.mp4$/);
        if (!match) {
            throw new Error(`Invalid video path format: ${videoPath}`);
        }
        const videoFilename = match[1];
        
        // Get srcArray to verify it exists
        const videoDoc = await db.collection('lessons').doc(videoFilename).get();
        if (!videoDoc.exists) {
            throw new Error(`Video document not found: ${videoFilename}`);
        }
        
        const videoData = videoDoc.data();
        const srcArray = videoData.srcArray || [];
        
        if (srcArray.length === 0) {
            return { 
                success: false, 
                skipped: true, 
                reason: 'srcArray is empty for video' 
            };
        }
        
        // Extract menu links from HTML to get all available segment link labels
        const menuLinks = await extractMenuLinksFromHTML(lesson.path);
        const segmentLinks = menuLinks.map(link => ({ label: link.label }));
        
        // Call Cloud Function to detect titles and adjust srcArray
        const detectVideoTitlesFunction = functions.httpsCallable('detectVideoTitles');
        const result = await detectVideoTitlesFunction({
            videoPath: videoPath,
            videoFilename: videoFilename,
            lessonId: lessonId,
            segmentLinks: segmentLinks
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
        const videoPathData = videoPathDoc.data();
        const videoPath = videoPathData.videoPath;

        // Extract video filename from videoPath (e.g., "videos/filename.mp4" → "filename")
        const match = videoPath.match(/videos\/([^\/]+)\.mp4$/);
        if (!match) {
            setStatus('Invalid video path format for this lesson', 'error');
            return;
        }
        const videoFilename = match[1];

        // Get ordered chapter labels from lesson HTML (menu buttons)
        const menuLinks = await extractMenuLinksFromHTML(lesson.path);
        if (!menuLinks.length) {
            setStatus('No chapters found for this lesson', 'error');
            return;
        }
        const chapters = menuLinks.map(link => link.label);

        setStatus('Generating timeline from yellow screens...', 'scanning');

        const generateFn = functions.httpsCallable('generateSrcArrayFromYellowScreens');
        const result = await generateFn({
            videoPath,
            videoFilename,
            lessonId,
            chapters
        });

        const data = result.data || {};
        if (!data.success) {
            const msg = data.reason || 'Generation failed';
            setStatus(`Auto-generate failed: ${msg}`, 'error');
        } else {
            const segs = data.segments || 0;
            setStatus(`Generated ${segs} segments from yellow screens`, data.status === 'ok' ? 'success' : 'scanning');
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
window.saveSectionDisplayName = async function saveSectionDisplayName(originalSection) {
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
    }
};
window.scrollToLesson = function scrollToLesson(lessonId) {
    selectLesson(lessonId);
};

