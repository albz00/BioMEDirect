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
let loginScreen, dashboardScreen, loginForm, logoutBtn, scanBtn, refreshVideosBtn, mapSegmentLinksBtn, detectVideoTitlesBtn, statusText, loginError, lessonsList, videosList;
let uploadVideoBtn, uploadVideoInput;
let instructionsBtn, changelogBtn, instructionsModal, changelogModal;
let searchInput, filterButtons;
let currentFilter = 'all';
let searchQuery = '';

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
    logoutBtn = document.getElementById('logoutBtn');
    instructionsBtn = document.getElementById('instructionsBtn');
    changelogBtn = document.getElementById('changelogBtn');
    scanBtn = document.getElementById('scanBtn');
    refreshVideosBtn = document.getElementById('refreshVideosBtn');
    uploadVideoBtn = document.getElementById('uploadVideoBtn');
    uploadVideoInput = document.getElementById('uploadVideoInput');
    mapSegmentLinksBtn = document.getElementById('mapSegmentLinksBtn');
    detectVideoTitlesBtn = document.getElementById('detectVideoTitlesBtn');
    statusText = document.getElementById('statusText');
    loginError = document.getElementById('loginError');
    lessonsList = document.getElementById('lessonsList');
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

    if (changelogBtn && changelogModal) {
        changelogBtn.addEventListener('click', () => openModal(changelogModal));
    }

    // Generic close handlers (backdrop or [data-close-modal] button)
    [instructionsModal, changelogModal].forEach((modal) => {
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

    // Close modals with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            [instructionsModal, changelogModal].forEach((modal) => {
                if (modal && !modal.classList.contains('hidden')) {
                    closeModal(modal);
                }
            });
        }
    });

    // Logout
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                await auth.signOut();
                console.log('User logged out successfully');
                // Redirect to main menu after logout
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
    if (mapSegmentLinksBtn) {
        mapSegmentLinksBtn.addEventListener('click', async () => {
            await mapAllSegmentLinks();
        });
    }
    if (detectVideoTitlesBtn) {
        detectVideoTitlesBtn.addEventListener('click', async () => {
            await detectVideoTitlesForAllLessons();
        });
    }

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
            displayLessons();
        });
    }

    // Filter Buttons
    if (filterButtons) {
        filterButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                // Remove active class from all buttons
                filterButtons.forEach(b => b.classList.remove('active'));
                // Add active class to clicked button
                e.target.classList.add('active');
                // Update current filter
                currentFilter = e.target.getAttribute('data-filter');
                displayLessons();
            });
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
        displayAvailableVideos();
        setStatus(`Loaded ${availableVideos.length} videos`, 'success');
    } catch (error) {
        console.error('Error loading videos:', error);
        setStatus('Error loading videos: ' + error.message, 'error');
    } finally {
        refreshVideosBtn.disabled = false;
    }
}

function displayAvailableVideos() {
    if (availableVideos.length === 0) {
        videosList.innerHTML = '<p class="placeholder">No videos found in Storage</p>';
        return;
    }
    
    videosList.innerHTML = availableVideos.map(video => 
        `<div class="video-item">${video}</div>`
    ).join('');
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
    lessonsList.innerHTML = '<div class="spinner"></div>';
    
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
        
        renderSectionIndex();
        displayLessons();
        
        const missingCount = lessonsData.filter(l => !l.hasVideo).length;
        const totalCount = lessonsData.length;
        
        setStatus(`Scan complete: ${missingCount} missing, ${totalCount - missingCount} found`, 
                  missingCount > 0 ? 'error' : 'success');
    } catch (error) {
        console.error('Error scanning lessons:', error);
        setStatus('Error scanning lessons: ' + error.message, 'error');
        lessonsList.innerHTML = '<p class="placeholder">Error loading lessons</p>';
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

function renderSectionIndex() {
    const sectionIndexEl = document.getElementById('sectionIndex');
    if (!sectionIndexEl || lessonsData.length === 0) return;

    // Group lessons by originalSection
    const groups = {};
    for (const lesson of lessonsData) {
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

        const lessonItems = section.lessons
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(lesson => {
                const safeLessonName = lesson.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const status = lesson.hasVideo ? '●' : '○';
                const statusClass = lesson.hasVideo ? 'has-video' : 'missing';
                return `
                    <li class="section-lesson ${statusClass}" data-lesson-id="${lesson.lessonId}"
                        onclick="scrollToLesson('${lesson.lessonId}')">
                        <span class="section-lesson-status">${status}</span>
                        <span class="section-lesson-name">${safeLessonName}</span>
                    </li>
                `;
            }).join('');

        return `
            <div class="section-index-item">
                <div class="section-index-header">
                    <div class="section-index-title">
                        <span class="section-index-original">${safeOriginalSection}</span>
                    </div>
                    <div class="section-index-edit">
                        <input
                            type="text"
                            class="section-index-input"
                            id="section-index-input-${section.originalSection.replace(/[^a-zA-Z0-9_-]/g, '_')}"
                            value="${safeSectionName}"
                        >
                        <button
                            type="button"
                            class="btn-section-save"
                            onclick="saveSectionDisplayName('${section.originalSection.replace(/'/g, "\\'")}')"
                        >
                            Save
                        </button>
                    </div>
                </div>
                <ul class="section-lesson-list">
                    ${lessonItems}
                </ul>
            </div>
        `;
    }).join('');

    sectionIndexEl.innerHTML = html;
}

function displayLessons() {
    if (lessonsData.length === 0) {
        lessonsList.innerHTML = '<p class="placeholder">No lessons found</p>';
        return;
    }
    
    // Filter lessons based on search query and filter type
    let filteredLessons = lessonsData.filter(lesson => {
        // Apply search filter
        if (searchQuery) {
            const matchesSearch = lesson.name.toLowerCase().includes(searchQuery) ||
                                 lesson.lessonId.toLowerCase().includes(searchQuery) ||
                                 lesson.path.toLowerCase().includes(searchQuery);
            if (!matchesSearch) return false;
        }
        
        // Apply status filter
        if (currentFilter === 'missing') {
            return !lesson.hasVideo;
        } else if (currentFilter === 'has-video') {
            return lesson.hasVideo;
        }
        // currentFilter === 'all'
        return true;
    });
    
    if (filteredLessons.length === 0) {
        lessonsList.innerHTML = '<p class="placeholder">No lessons match your search/filter criteria</p>';
        return;
    }
    
    lessonsList.innerHTML = filteredLessons.map(lesson => {
        const statusClass = lesson.hasVideo ? 'has-video' : 'missing';
        const statusText = lesson.hasVideo ? 'Has Video' : 'Missing';
        
        // Create options for video selector
        const videoOptions = availableVideos.map(video => {
            const selected = lesson.currentPath === `videos/${video}` ? 'selected' : '';
            return `<option value="${video}" ${selected}>${video}</option>`;
        }).join('');
        
        // Escape HTML in lesson name and section to prevent XSS
        const safeName = lesson.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeLessonId = lesson.lessonId.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safePath = lesson.path.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeSection = (lesson.section || 'Uncategorized').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeOriginalName = (lesson.originalName || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeOriginalSection = (lesson.originalSection || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
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
                        <button class="btn-metadata-save" onclick="saveLessonMetadata('${lesson.lessonId}')">
                            Save Lesson Name
                        </button>
                    </div>
                    <div class="assignment-row">
                        <select id="video-select-${lesson.lessonId}">
                            <option value="">${lesson.hasVideo ? 'Change video...' : 'Select a video...'}</option>
                            ${videoOptions}
                        </select>
                        <button onclick="assignVideo('${lesson.lessonId}')" id="assign-btn-${lesson.lessonId}">
                            ${lesson.hasVideo ? 'Update' : 'Assign'}
                        </button>
                    </div>
                    <div class="yellow-screen-option">
                        <label>
                            <input type="checkbox" id="yellow-screen-${lesson.lessonId}" 
                                   ${lesson.yellowScreen ? 'checked' : ''} 
                                   onchange="toggleYellowScreen('${lesson.lessonId}')">
                            Remove yellow screen (adjust srcArray)
                        </label>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

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

        displayLessons();
        renderSectionIndex();
        setStatus('Lesson metadata saved', 'success');
        setTimeout(() => setStatus('Ready'), 3000);
    } catch (error) {
        console.error('Error saving lesson metadata:', error);
        alert('Error saving lesson metadata: ' + error.message);
    } finally {
        nameInput.disabled = false;
    }
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
        
        // Re-render to show updated status
        displayLessons();
        
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

        renderSectionIndex();
        displayLessons();
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
    const el = document.getElementById(`lesson-${lessonId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

