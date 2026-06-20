// Acquire the VS Code API object
declare const acquireVsCodeApi: any; // Use declare to inform TS about the global function
const vscode = acquireVsCodeApi();
const WEBVIEW_DEBUG = false;
const debugLog = WEBVIEW_DEBUG ? console.log.bind(console) : (..._args: unknown[]) => undefined;

// Get references to DOM elements
const logContainer = document.getElementById('log-container');
const popup = document.getElementById('file-select-popup');
const popupList = document.getElementById('file-select-list');
const popupCloseBtn = document.getElementById('popup-close-btn');
const lockScrollBtn = document.getElementById('lock-scroll-btn') as HTMLButtonElement | null;
const clearLogBtn = document.getElementById('clear-log-btn') as HTMLButtonElement | null;
const toggleBgBtn = document.getElementById('toggle-bg-btn') as HTMLButtonElement | null;
const toggleLocationBtn = document.getElementById('toggle-location-btn') as HTMLButtonElement | null;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement | null;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement | null;
const nodeaidBtn = document.getElementById('nodeaid-btn') as HTMLButtonElement | null;
const debugBtn = document.getElementById('debug-btn') as HTMLButtonElement | null;

// New toolbar buttons
const connectDeviceBtn = document.getElementById('connect-device-btn') as HTMLButtonElement | null;
const compileProjectBtn = document.getElementById('compile-project-btn') as HTMLButtonElement | null;
const fileOperationsBtn = document.getElementById('file-operations-btn') as HTMLButtonElement | null;
const compileProjectMenu = document.getElementById('compile-project-menu') as HTMLElement | null;
const fileOperationsMenu = document.getElementById('file-operations-menu') as HTMLElement | null;

// Settings dropdown button (New)
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement | null;
const settingsMenu = document.getElementById('settings-menu') as HTMLElement | null;

// Quick Config and Search buttons
const quickConfigBtn = document.getElementById('quick-config-btn') as HTMLButtonElement | null;
const quickConfigMenu = document.getElementById('quick-config-menu') as HTMLElement | null;
const searchBtn = document.getElementById('search-btn') as HTMLButtonElement | null;

// Search interface elements (New IDs for Find Widget)
const findWidget = document.getElementById('find-widget') as HTMLElement | null;
const findInput = document.getElementById('find-input') as HTMLInputElement | null;
const findHistoryBtn = document.getElementById('find-history-btn') as HTMLButtonElement | null;
const findCaseSensitiveBtn = document.getElementById('find-case-sensitive-btn') as HTMLButtonElement | null;
const findWholeWordBtn = document.getElementById('find-whole-word-btn') as HTMLButtonElement | null;
const findRegexBtn = document.getElementById('find-regex-btn') as HTMLButtonElement | null;
const findInSelectionBtn = document.getElementById('find-in-selection-btn') as HTMLButtonElement | null;
const findResultsCount = document.getElementById('find-results-count') as HTMLElement | null;
const findPrevBtn = document.getElementById('find-prev-btn') as HTMLButtonElement | null;
const findNextBtn = document.getElementById('find-next-btn') as HTMLButtonElement | null;
const findCloseBtn = document.getElementById('find-close-btn') as HTMLButtonElement | null;

debugLog("[Webview] DOM elements references acquired."); // 新增日志
debugLog("[Webview] Find widget elements:", {
    findWidget: !!findWidget,
    findInput: !!findInput,
    findPrevBtn: !!findPrevBtn,
    findNextBtn: !!findNextBtn,
    findResultsCount: !!findResultsCount
});

// --- State Variables --- (Keep track of UI state)
let isScrollLocked = false;
let backgroundMode = 'gradient'; // Default to gradient
let isRunCommandRunning = false;

// Search functionality state
let isFindWidgetActive = false; // Renamed from isSearchActive
let searchMatches: HTMLElement[] = [];
let currentMatchIndex = -1;
let lastSearchQuery = '';
let isCaseSensitiveActive = false;
let isWholeWordActive = false; // New state for whole word
let isRegexActive = false;
let isInSelectionActive = false; // New state for search in selection

// Search history functionality
let searchHistory: string[] = [];
let searchHistoryIndex = -1;
const MAX_SEARCH_HISTORY = 20;

// Selection-based search functionality
let selectedElements: HTMLElement[] = [];
let selectedText = '';
let targetPlatform: 'android' | 'ios' = 'android';

// Store context for the file selection popup
interface FileOption {
    label: string;
    description: string;
    fullPath: string;
}
let currentPopupContext: {
    lineNumber: number;
    targetElement: HTMLElement | null;
    fileOptions: FileOption[];
} = {
    lineNumber: 0,
    targetElement: null,
    fileOptions: []
};

// --- Initial Setup ---

debugLog("[Webview] Initializing setup..."); // 新增日志

// Function to post message back to the extension
function postMessage(command: string, payload?: any) {
    vscode.postMessage({ command, payload });
}

// --- Message Handling from Extension ---

window.addEventListener('message', event => {
    const message = event.data;
    debugLog("[Webview] Received message: ", message.command, message); // 已存在的日志

    switch (message.command) {
        case 'addLog':
            debugLog("[Webview] Handling addLog."); // 新增日志
            if (logContainer && typeof message.htmlContent === 'string') {
                appendLog(message.htmlContent);
            } else {
                console.warn('[Webview] Invalid addLog message:', message);
            }
            break;
        case 'restoreLogs':
            debugLog("[Webview] Handling restoreLogs."); // 新增日志
            if (logContainer && Array.isArray(message.logs)) {
                restoreLogs(message.logs);
            } else {
                 console.warn('[Webview] Invalid restoreLogs message:', message);
            }
            break;
        case 'requestFileSelection':
            debugLog("[Webview] Handling requestFileSelection."); // 新增日志
            if (
                message.payload &&
                Array.isArray(message.payload.fileOptions) &&
                typeof message.payload.lineNumber === 'number' &&
                typeof message.payload.linkId === 'string'
            ) {
                 showFileSelectionPopup(message.payload.fileOptions, message.payload.lineNumber, message.payload.linkId);
            } else {
                console.warn('[Webview] Invalid requestFileSelection message:', message);
            }
            break;
        case 'setState':
             debugLog("[Webview] Handling setState.");
             if (message.payload) {
                 // isScrollLocked = message.payload.isScrollLocked ?? isScrollLocked; // 如果后端也发送了滚动状态
                 backgroundMode = message.payload.backgroundMode ?? backgroundMode; // 应用后端发送的主题
                 // updateScrollLockButton(); // 如果后端发送了滚动状态
                 updateBackground(); // 更新背景
                 debugLog("[Webview] Initial backgroundMode set to:", backgroundMode);
                 if (message.payload.targetPlatform) {
                     targetPlatform = message.payload.targetPlatform;
                     updateCompileMenu();
                     debugLog("[Webview] Initial targetPlatform set to:", targetPlatform);
                 }
                 setRunButtonRunning(Boolean(message.payload.runCommandRunning));
              }
              break;
        case 'setRunState':
             debugLog("[Webview] Handling setRunState.");
             setRunButtonRunning(Boolean(message.payload?.running));
             break;
        case 'setCompileMenu':
             debugLog("[Webview] Handling setCompileMenu.");
             if (message.payload && message.payload.targetPlatform) {
                 targetPlatform = message.payload.targetPlatform;
                 updateCompileMenu();
                 debugLog("[Webview] targetPlatform updated to:", targetPlatform);
             }
             break;
    }
});

// --- Log Appending and History Restoration ---

function appendLog(htmlContent: string) {
    if (!logContainer) return;
    debugLog("[Webview] Appending log content..."); // 新增日志
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlContent;

    // Ensure links have unique IDs (although might be redundant if formatted with timestamp)
    const links = tempDiv.querySelectorAll('.file-link');
    links.forEach((link, index) => {
        if (!link.id) {
             link.id = `file-link-${Date.now()}-${index}`;
        }
    });

    while (tempDiv.firstChild) {
        logContainer.appendChild(tempDiv.firstChild);
    }

    // If search is active, re-perform search to include new content
    if (isFindWidgetActive && findInput && findInput.value) {
        debugLog("[Webview] Re-performing search after new log added");
        performSearch();
    }

    // Auto-scroll if not locked
    if (!isScrollLocked) {
        scrollToBottom();
    }
}

function restoreLogs(logs: string[]) {
    if (!logContainer) return;
    debugLog("[Webview] Restoring logs from history..."); // 新增日志
    // Clear existing logs first
    logContainer.innerHTML = '';
    // Append all logs from history
    logs.forEach(logHtml => appendLog(logHtml));
    // Scroll to bottom after restoring, unless locked
    if (!isScrollLocked) {
        scrollToBottom();
    }
}

function updateCompileMenu() {
    const androidItems = document.querySelectorAll('.android-item');
    const iosItems = document.querySelectorAll('.ios-item');

    androidItems.forEach(item => {
        (item as HTMLElement).style.display = targetPlatform === 'android' ? '' : 'none';
    });

    iosItems.forEach(item => {
        (item as HTMLElement).style.display = targetPlatform === 'ios' ? '' : 'none';
    });
}

function scrollToBottom() {
     requestAnimationFrame(() => {
         if (logContainer) {
             logContainer.scrollTop = logContainer.scrollHeight;
         }
     });
}

// --- Event Listeners for User Actions ---

// Delegated event listener for file links
logContainer?.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('.file-link');
    if (link instanceof HTMLAnchorElement) {
        e.preventDefault();
        debugLog("[Webview] File link clicked:", link.id); // 新增日志
        const filePath = link.getAttribute('data-file-path');
        const lineNumber = parseInt(link.getAttribute('data-line-number') || '0', 10);
        const linkId = link.id;

        if (filePath && !isNaN(lineNumber) && linkId) {
            postMessage('openFile', { filePath, lineNumber, linkId });
        } else {
             console.warn('[Webview] Clicked file link missing data:', link);
        }
    }
});

// File Selection Popup Logic
function showFileSelectionPopup(fileOptions: FileOption[], lineNumber: number, linkId: string) {
    debugLog("[Webview] Showing file selection popup for link:", linkId); // 新增日志
    const targetElement = document.getElementById(linkId);
    if (!targetElement || !popup || !popupList) {
        console.warn('[Webview] Cannot show popup: Missing element.', {targetElement, popup, popupList});
        return;
    }

    currentPopupContext = {
        lineNumber: lineNumber,
        targetElement: targetElement,
        fileOptions: fileOptions
    };

    popupList.innerHTML = ''; // Clear previous options

    fileOptions.forEach(option => {
        const li = document.createElement('li');
        // Add icon placeholder (styling via CSS)
        const iconSpan = document.createElement('span');
        iconSpan.className = 'file-icon';
        li.appendChild(iconSpan);
        // Add path info container
        const pathInfoSpan = document.createElement('span');
        pathInfoSpan.className = 'path-info';
        // Add label (relative path)
        const labelSpan = document.createElement('span');
        labelSpan.className = 'path-label';
        labelSpan.textContent = option.label;
        labelSpan.title = option.label; // Tooltip for long paths
        pathInfoSpan.appendChild(labelSpan);
        // Add description (full path) if available
        if (option.description) {
            const descSpan = document.createElement('span');
            descSpan.className = 'description';
            descSpan.textContent = option.description;
            descSpan.title = option.description; // Tooltip for long paths
            pathInfoSpan.appendChild(descSpan);
        }
        li.appendChild(pathInfoSpan);
        li.dataset.fullPath = option.fullPath; // Store full path for selection
        popupList.appendChild(li);
    });

    // Position and display the popup (similar logic as before)
    const rect = targetElement.getBoundingClientRect();
    const containerRect = logContainer!.getBoundingClientRect(); // Use non-null assertion as we check logContainer earlier
    let top = rect.bottom + logContainer!.scrollTop - containerRect.top + 5;
    let left = rect.left - containerRect.left;

    popup.style.setProperty('--popup-base-left', `${left}px`);
    popup.style.setProperty('--popup-base-top', `${top}px`);
    popup.style.display = 'block';
    debugLog('[Webview] Popup display set to block.'); // 修改日志内容

    // Adjust position if out of bounds (simplified adjustment)
     requestAnimationFrame(() => { // Ensure layout is calculated
         const popupRect = popup.getBoundingClientRect();
         if (popupRect.right > window.innerWidth) {
             popup.style.left = `${window.innerWidth - popupRect.width - 20}px`; // Use style.left directly for override
         } else {
             popup.style.left = `${left}px`; // Reset if fits
         }
         if (popupRect.bottom > window.innerHeight) {
             popup.style.top = `${rect.top + logContainer!.scrollTop - containerRect.top - popupRect.height - 5}px`;
         } else {
            popup.style.top = `${top}px`; // Reset if fits
         }
     });
}

function hideFileSelectionPopup() {
    if (popup) {
        debugLog("[Webview] Hiding file selection popup."); // 新增日志
        popup.style.display = 'none';
        popup.style.left = ''; // Reset position overrides
        popup.style.top = '';
    }
    currentPopupContext = { lineNumber: 0, targetElement: null, fileOptions: [] };
}

// Listener for selecting an item in the popup
popupList?.addEventListener('click', (e) => {
    const listItem = (e.target as HTMLElement).closest('li');
    if (listItem && listItem.dataset.fullPath) {
        debugLog("[Webview] File selected from popup:", listItem.dataset.fullPath); // 新增日志
        const selectedPath = listItem.dataset.fullPath;
        postMessage('fileSelected', {
            selectedPath: selectedPath,
            lineNumber: currentPopupContext.lineNumber
        });
        hideFileSelectionPopup();
    }
});

// Listener for the popup close button
popupCloseBtn?.addEventListener('click', () => {
    debugLog("[Webview] Popup close button clicked."); // 新增日志
    hideFileSelectionPopup();
});

// Listener to close popup if clicked outside
document.addEventListener('click', (event) => {
    if (popup && popup.style.display === 'block') {
        const isClickInsidePopup = popup.contains(event.target as Node);
        const isClickOnOriginalLink = currentPopupContext.targetElement?.contains(event.target as Node);

        if (!isClickInsidePopup && !isClickOnOriginalLink) {
            debugLog("[Webview] Clicked outside popup, hiding."); // 新增日志
            hideFileSelectionPopup();
        }
    }
});


// --- Control Button Logic ---

if (lockScrollBtn) {
    const lockIcon = lockScrollBtn.querySelector('.icon') as HTMLElement | null;

    if (lockIcon) {
        lockScrollBtn.addEventListener('click', () => {
            isScrollLocked = !isScrollLocked;
            updateScrollLockButton();
            vscode.postMessage({
                command: 'scrollLockChanged',
                payload: { isLocked: isScrollLocked }
            });
        });
        updateScrollLockButton();
    } else {
        console.error("Could not find icon element within lockScrollBtn for event listener setup.");
        lockScrollBtn.addEventListener('click', () => {
             isScrollLocked = !isScrollLocked;
             lockScrollBtn.classList.toggle('active', isScrollLocked);
             lockScrollBtn.textContent = isScrollLocked ? '🔒' : '🔓';
             lockScrollBtn.title = isScrollLocked ? '解锁滚动' : '锁定滚动';
             vscode.postMessage({ command: 'scrollLockChanged', payload: { isLocked: isScrollLocked } });
        });
        if (lockScrollBtn) {
             lockScrollBtn.textContent = isScrollLocked ? '🔒' : '🔓';
             lockScrollBtn.title = isScrollLocked ? '解锁滚动' : '锁定滚动';
        }
    }
}

clearLogBtn?.addEventListener('click', () => {
    if (logContainer) {
        debugLog("[Webview] Clear log button clicked."); // 新增日志
        logContainer.innerHTML = ''; // Clear visually
        vscode.postMessage({ command: 'clearLogClicked' }); // 通知扩展清空历史记录
    }
});

// Toggle Background Button
toggleBgBtn?.addEventListener('click', () => {
    debugLog(`[Webview] Toggle background button clicked.`);
    const oldMode = backgroundMode;
    if (backgroundMode === 'gradient') {
        backgroundMode = 'starry';
    } else if (backgroundMode === 'starry') {
        backgroundMode = 'none';
    } else {
        backgroundMode = 'gradient';
    }
    updateBackground();
    // 发送正确的命令和 payload 给后端以保存状态
    postMessage('backgroundModeChanged', { mode: backgroundMode }); // 使用 backgroundModeChanged 和 { mode: ... }
});

// Toggle Location Button
toggleLocationBtn?.addEventListener('click', () => {
    debugLog("[Webview] Toggle location button clicked."); // 新增日志
    postMessage('toggleLogLocation'); // Send message to extension
});

// Run Button Listener (New)
runBtn?.addEventListener('click', () => {
    debugLog("[Webview] Run button clicked.");
    if (isRunCommandRunning) {
        return;
    }

    postMessage('runProject'); // Send message to extension
});

// Stop Button Listener (New)
stopBtn?.addEventListener('click', () => {
    debugLog("[Webview] Stop button clicked.");
    postMessage('stopProject'); // Send message to extension
});

// Node Aid Button Listener (New)
nodeaidBtn?.addEventListener('click', () => {
    debugLog("[Webview] Node Aid button clicked.");
    postMessage('nodeAid'); // Send message to extension
});

// Debug Button Listener
debugBtn?.addEventListener('click', () => {
    debugLog("[Webview] Debug button clicked.");
    postMessage('quickDebugMainGo');
});

// Connect Device Button Listener
connectDeviceBtn?.addEventListener('click', () => {
    debugLog("[Webview] Connect Device button clicked.");
    postMessage('connectDevice'); // Send message to extension
});

// Compile Project Dropdown Logic
if (compileProjectBtn && compileProjectMenu) {
    compileProjectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        debugLog("[Webview] Compile Project dropdown button clicked.");
        toggleDropdown(compileProjectBtn.parentElement as HTMLElement);
        // Close other dropdowns if open
        closeDropdown(fileOperationsBtn?.parentElement as HTMLElement);
        closeDropdown(quickConfigBtn?.parentElement as HTMLElement);
        closeDropdown(settingsBtn?.parentElement as HTMLElement);
    });

    // Handle dropdown menu item clicks
    compileProjectMenu.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const dropdownItem = target.closest('.dropdown-item') as HTMLButtonElement;
        if (dropdownItem && dropdownItem.dataset.command) {
            debugLog(`[Webview] Compile menu item clicked: ${dropdownItem.dataset.command}`);
            postMessage('executeCommand', { command: dropdownItem.dataset.command });
            closeDropdown(compileProjectBtn.parentElement as HTMLElement);
        }
    });
}

// File Operations Dropdown Logic
if (fileOperationsBtn && fileOperationsMenu) {
    fileOperationsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        debugLog("[Webview] File Operations dropdown button clicked.");
        toggleDropdown(fileOperationsBtn.parentElement as HTMLElement);
        // Close other dropdowns if open
        closeDropdown(compileProjectBtn?.parentElement as HTMLElement);
        closeDropdown(quickConfigBtn?.parentElement as HTMLElement);
        closeDropdown(settingsBtn?.parentElement as HTMLElement);
    });

    // Handle dropdown menu item clicks
    fileOperationsMenu.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const dropdownItem = target.closest('.dropdown-item') as HTMLButtonElement;
        if (dropdownItem && dropdownItem.dataset.command) {
            debugLog(`[Webview] File operations menu item clicked: ${dropdownItem.dataset.command}`);
            postMessage('executeCommand', { command: dropdownItem.dataset.command });
            closeDropdown(fileOperationsBtn.parentElement as HTMLElement);
        }
    });
}

// Quick Config Dropdown Logic
if (quickConfigBtn && quickConfigMenu) {
    quickConfigBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        debugLog("[Webview] Quick Config dropdown button clicked.");
        toggleDropdown(quickConfigBtn.parentElement as HTMLElement);
        // Close other dropdowns if open
        closeDropdown(compileProjectBtn?.parentElement as HTMLElement);
        closeDropdown(fileOperationsBtn?.parentElement as HTMLElement);
        closeDropdown(settingsBtn?.parentElement as HTMLElement);
    });

    // Handle dropdown menu item clicks
    quickConfigMenu.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const dropdownItem = target.closest('.dropdown-item') as HTMLButtonElement;
        if (dropdownItem && dropdownItem.dataset.command) {
            debugLog(`[Webview] Quick config menu item clicked: ${dropdownItem.dataset.command}`);
            postMessage('executeCommand', { command: dropdownItem.dataset.command });
            closeDropdown(quickConfigBtn.parentElement as HTMLElement);
        }
    });
}

// Settings Dropdown Logic (New)
if (settingsBtn && settingsMenu) {
    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        debugLog("[Webview] Settings dropdown button clicked.");
        toggleDropdown(settingsBtn.parentElement as HTMLElement);
        // Close other dropdowns if open
        closeDropdown(compileProjectBtn?.parentElement as HTMLElement);
        closeDropdown(fileOperationsBtn?.parentElement as HTMLElement);
        closeDropdown(quickConfigBtn?.parentElement as HTMLElement);
    });

    // Handle dropdown menu item clicks
    settingsMenu.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const dropdownItem = target.closest('.dropdown-item') as HTMLButtonElement;
        if (dropdownItem && dropdownItem.dataset.command) {
            debugLog(`[Webview] Settings menu item clicked: ${dropdownItem.dataset.command}`);
            postMessage('executeCommand', { command: dropdownItem.dataset.command });
            closeDropdown(settingsBtn.parentElement as HTMLElement);
        }
    });
}

// Global click handler to close dropdowns when clicking outside
document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    // Close file selection popup if clicked outside
    if (popup && popup.style.display === 'block') {
        const isClickInsidePopup = popup.contains(target);
        const isClickOnOriginalLink = currentPopupContext.targetElement?.contains(target);

        if (!isClickInsidePopup && !isClickOnOriginalLink) {
            debugLog("[Webview] Clicked outside popup, hiding."); // 新增日志
            hideFileSelectionPopup();
        }
    }

    // Close dropdowns if clicked outside
    if (!target.closest('.dropdown-container')) {
        closeAllDropdowns();
    }
});

// Dropdown helper functions
function toggleDropdown(container: HTMLElement | null) {
    if (container) {
        container.classList.toggle('active');
    }
}

function closeDropdown(container: HTMLElement | null) {
    if (container) {
        container.classList.remove('active');
    }
}

function closeAllDropdowns() {
    const allDropdowns = document.querySelectorAll('.dropdown-container');
    allDropdowns.forEach(dropdown => {
        dropdown.classList.remove('active');
    });
}

// --- UI Update Functions ---

function setRunButtonRunning(running: boolean): void {
    isRunCommandRunning = running;

    const runIcon = runBtn?.querySelector('.icon') as HTMLElement | null;
    if (!runBtn || !runIcon) {
        return;
    }

    runIcon.classList.remove('codicon-run', 'codicon-debug-pause');
    runIcon.classList.add(running ? 'codicon-debug-pause' : 'codicon-run');
    runBtn.title = running ? '运行中' : '运行项目 (F5)';
}

function updateScrollLockButton() {
     if (lockScrollBtn) {
        const lockIcon = lockScrollBtn.querySelector('.icon') as HTMLElement | null;
        if (lockIcon) {
            const lockClass = lockIcon.dataset.lockIcon || 'codicon-lock';
            const unlockClass = lockIcon.dataset.unlockIcon || 'codicon-unlock';

            lockScrollBtn.classList.toggle('active', isScrollLocked);

            lockIcon.classList.remove(lockClass, unlockClass);
            lockIcon.classList.add(isScrollLocked ? lockClass : unlockClass);
            lockScrollBtn.title = isScrollLocked ? '解锁滚动' : '锁定滚动';
        } else {
             console.error("Could not find icon element within lockScrollBtn during update.");
             lockScrollBtn.textContent = isScrollLocked ? '🔒' : '🔓';
             lockScrollBtn.title = isScrollLocked ? '解锁滚动' : '锁定滚动';
        }
     }
}

function updateBackground() {
    const body = document.body;

    if (!body) {
        return;
    }

    body.classList.remove('gradient-background', 'starry-background', 'none-background');

    let classToAdd = 'none-background';
    if (backgroundMode === 'gradient') {
        classToAdd = 'gradient-background';
    } else if (backgroundMode === 'starry') {
        classToAdd = 'starry-background';
    }
    body.classList.add(classToAdd);
}

// --- Initialization ---

if (popup) {
    popup.style.display = 'none';
    debugLog("[Webview] Popup initially hidden."); // 新增日志
}

updateScrollLockButton();
updateBackground();

postMessage('webviewReady');

debugLog("[Webview] Script loaded and ready.");

// Event Listeners for Find Widget
searchBtn?.addEventListener('click', () => {
    debugLog("[Webview] Search button (toolbar) clicked.");
    toggleFindWidget();
});

findCloseBtn?.addEventListener('click', () => {
    debugLog("[Webview] Find widget close button clicked.");
    closeFindWidget();
});

findInput?.addEventListener('input', () => {
    performSearch();
});

findInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        // Add current query to search history when user presses Enter
        if (findInput.value.trim()) {
            addToSearchHistory(findInput.value.trim());
        }
        if (e.shiftKey) {
            navigateSearchResult('prev');
        } else {
            navigateSearchResult('next');
        }
    } else if (e.key === 'Escape') {
        closeFindWidget();
    } else if (e.key === 'ArrowUp' && e.altKey) {
        e.preventDefault();
        navigateSearchHistory('up');
    } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        navigateSearchHistory('down');
    }
});

findPrevBtn?.addEventListener('click', () => {
    debugLog("[Webview] Previous button clicked");
    // Add current query to search history when user navigates
    if (findInput && findInput.value.trim()) {
        addToSearchHistory(findInput.value.trim());
    }
    navigateSearchResult('prev');
});

findNextBtn?.addEventListener('click', () => {
    debugLog("[Webview] Next button clicked");
    // Add current query to search history when user navigates
    if (findInput && findInput.value.trim()) {
        addToSearchHistory(findInput.value.trim());
    }
    navigateSearchResult('next');
});

findCaseSensitiveBtn?.addEventListener('click', () => {
    isCaseSensitiveActive = !isCaseSensitiveActive;
    findCaseSensitiveBtn.classList.toggle('active', isCaseSensitiveActive);
    performSearch();
});

findWholeWordBtn?.addEventListener('click', () => {
    isWholeWordActive = !isWholeWordActive;
    findWholeWordBtn.classList.toggle('active', isWholeWordActive);
    performSearch();
});

findRegexBtn?.addEventListener('click', () => {
    isRegexActive = !isRegexActive;
    findRegexBtn.classList.toggle('active', isRegexActive);
    performSearch();
});

findInSelectionBtn?.addEventListener('click', () => {
    isInSelectionActive = !isInSelectionActive;
    findInSelectionBtn.classList.toggle('active', isInSelectionActive);

    if (isInSelectionActive) {
        // Capture current selection when activating
        captureCurrentSelection();
    } else {
        // Clear selection when deactivating
        clearSelection();
    }

    performSearch();
});

// Keyboard shortcuts for find widget and search options
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        debugLog("[Webview] Ctrl+F pressed, toggling find widget.");
        toggleFindWidget();
    } else if (isFindWidgetActive) {
        // Only handle these shortcuts when find widget is active
        if (e.altKey && e.key === 'c') {
            e.preventDefault();
            debugLog("[Webview] Alt+C pressed, toggling case sensitive.");
            if (findCaseSensitiveBtn) {
                findCaseSensitiveBtn.click();
            }
        } else if (e.altKey && e.key === 'w') {
            e.preventDefault();
            debugLog("[Webview] Alt+W pressed, toggling whole word.");
            if (findWholeWordBtn) {
                findWholeWordBtn.click();
            }
        } else if (e.altKey && e.key === 'r') {
            e.preventDefault();
            debugLog("[Webview] Alt+R pressed, toggling regex.");
            if (findRegexBtn) {
                findRegexBtn.click();
            }
        } else if (e.altKey && e.key === 'l') {
            e.preventDefault();
            debugLog("[Webview] Alt+L pressed, toggling search in selection.");
            if (findInSelectionBtn) {
                findInSelectionBtn.click();
            }
        } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            debugLog("[Webview] Alt+Arrow pressed, showing search history.");
            if (findHistoryBtn) {
                findHistoryBtn.click();
            }
        }
    }
});

function toggleFindWidget() {
    if (!findWidget) return;
    if (isFindWidgetActive) {
        closeFindWidget();
    } else {
        openFindWidget();
    }
}

function openFindWidget() {
    if (!findWidget || !findInput) return;
    isFindWidgetActive = true;
    findWidget.classList.add('active'); // Use CSS class instead of style.display
    findInput.focus();
    debugLog("[Webview] Find widget opened.");
}

function closeFindWidget() {
    if (!findWidget) return;
    isFindWidgetActive = false;
    findWidget.classList.remove('active'); // Use CSS class instead of style.display
    clearSearchHighlights();
    searchMatches = [];
    currentMatchIndex = -1;

    // Clear selection state when closing find widget
    if (isInSelectionActive) {
        isInSelectionActive = false;
        if (findInSelectionBtn) {
            findInSelectionBtn.classList.remove('active');
        }
        clearSelection();
    }

    updateSearchResults();
    debugLog("[Webview] Find widget closed.");
}

// Selection-based search functions
function captureCurrentSelection() {
    selectedElements = [];
    selectedText = '';

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        debugLog("[Webview] No text selection found");
        return;
    }

    try {
        const range = selection.getRangeAt(0);
        selectedText = range.toString();

        // Find all log lines that intersect with the selection
        if (logContainer) {
            const allLogLines = Array.from(logContainer.querySelectorAll('.log-line'));
            selectedElements = allLogLines.filter(line => {
                return range.intersectsNode(line);
            }) as HTMLElement[];
        }

        debugLog(`[Webview] Captured selection: "${selectedText}", ${selectedElements.length} lines`);

        // Update button state to show selection is active
        if (findInSelectionBtn && selectedElements.length > 0) {
            findInSelectionBtn.title = `在选定内容中查找 (Alt+L) - ${selectedElements.length} 行被选中`;
        }
    } catch (error) {
        console.error("[Webview] Error capturing selection:", error);
        selectedElements = [];
        selectedText = '';
    }
}

function clearSelection() {
    selectedElements = [];
    selectedText = '';

    if (findInSelectionBtn) {
        findInSelectionBtn.title = "在选定内容中查找 (Alt+L)";
    }

    debugLog("[Webview] Selection cleared");
}

function performSearch() {
    if (!findInput || !logContainer) return;
    const query = findInput.value.trim();

    clearSearchHighlights();
    searchMatches = [];
    currentMatchIndex = -1;

    if (!query) {
        updateSearchResults();
        return;
    }

    try {
        const isCaseSensitive = isCaseSensitiveActive;
        const isRegexMode = isRegexActive;
        const isWholeWord = isWholeWordActive;

        let searchPattern: RegExp;
        let finalQuery = query;

        if (isRegexMode) {
            // Regex mode - use the query as-is but validate it
            try {
                const flags = isCaseSensitive ? 'g' : 'gi';
                searchPattern = new RegExp(finalQuery, flags);
            } catch (regexError) {
                console.error("[Webview] Invalid regex pattern:", regexError);
                if (findResultsCount) {
                    findResultsCount.textContent = "正则表达式错误";
                }
                return;
            }
        } else {
            // Literal search mode - escape special regex characters
            finalQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Add word boundary for whole word search
            if (isWholeWord) {
                finalQuery = `\\b${finalQuery}\\b`;
            }

            const flags = isCaseSensitive ? 'g' : 'gi';
            searchPattern = new RegExp(finalQuery, flags);
        }

        debugLog(`[Webview] Search pattern: ${searchPattern}, flags: ${searchPattern.flags}`);
        debugLog(`[Webview] Options - CaseSensitive: ${isCaseSensitive}, WholeWord: ${isWholeWord}, Regex: ${isRegexMode}`);

        // Search in all log lines or selected lines
        let logLines: Element[];
        if (isInSelectionActive && selectedElements.length > 0) {
            logLines = selectedElements;
            debugLog(`[Webview] Searching in ${selectedElements.length} selected lines`);
        } else {
            logLines = Array.from(logContainer.querySelectorAll('.log-line'));
            debugLog(`[Webview] Searching in all ${logLines.length} lines`);
        }

        logLines.forEach((line) => {
            const textContent = line.textContent || '';
            const matches = [...textContent.matchAll(searchPattern)];

            if (matches.length > 0) {
                highlightMatches(line as HTMLElement, matches, searchPattern);
            }
        });

        // Collect all highlighted elements
        searchMatches = Array.from(logContainer.querySelectorAll('.search-highlight'));

        if (searchMatches.length > 0) {
            currentMatchIndex = 0;
            updateCurrentMatch();
        }

        updateSearchResults();
        lastSearchQuery = query;

        // Note: addToSearchHistory is now called only when user explicitly searches (Enter key or navigation)

    } catch (error) {
        console.error("[Webview] Search error:", error);
        if (findResultsCount) {
            findResultsCount.textContent = "搜索错误";
        }
    }
}

function highlightMatches(element: HTMLElement, matches: RegExpMatchArray[], pattern: RegExp) {
    const textContent = element.textContent || '';
    const fragments: (string | HTMLElement)[] = [];
    let lastIndex = 0;

    // Reset the regex to start from the beginning
    pattern.lastIndex = 0;
    let match;

    while ((match = pattern.exec(textContent)) !== null) {
        // Add text before the match
        if (match.index > lastIndex) {
            fragments.push(textContent.slice(lastIndex, match.index));
        }

        // Create highlighted span for the match
        const span = document.createElement('span');
        span.className = 'search-highlight';
        span.textContent = match[0];
        fragments.push(span);

        lastIndex = match.index + match[0].length;

        // Prevent infinite loop for zero-length matches
        if (match[0].length === 0) {
            pattern.lastIndex++;
        }
    }

    // Add remaining text
    if (lastIndex < textContent.length) {
        fragments.push(textContent.slice(lastIndex));
    }

    // Replace element content with highlighted version
    element.innerHTML = '';
    fragments.forEach(fragment => {
        if (typeof fragment === 'string') {
            element.appendChild(document.createTextNode(fragment));
        } else {
            element.appendChild(fragment);
        }
    });
}

function clearSearchHighlights() {
    if (!logContainer) return;

    const highlights = logContainer.querySelectorAll('.search-highlight');
    highlights.forEach(highlight => {
        const parent = highlight.parentNode;
        if (parent) {
            parent.replaceChild(document.createTextNode(highlight.textContent || ''), highlight);
            parent.normalize(); // Merge adjacent text nodes
        }
    });
}

function navigateSearchResult(direction: 'next' | 'prev') {
    debugLog(`[Webview] navigateSearchResult called with direction: ${direction}`);
    debugLog(`[Webview] searchMatches.length: ${searchMatches.length}, currentMatchIndex: ${currentMatchIndex}`);

    if (searchMatches.length === 0) {
        debugLog("[Webview] No search matches available");
        return;
    }

    // Verify that search matches are still valid (in case DOM was modified)
    const validMatches = searchMatches.filter(match => document.contains(match));
    if (validMatches.length !== searchMatches.length) {
        debugLog(`[Webview] Some search matches are no longer in DOM. Valid: ${validMatches.length}, Total: ${searchMatches.length}`);
        searchMatches = validMatches;
        if (searchMatches.length === 0) {
            debugLog("[Webview] No valid search matches remaining");
            currentMatchIndex = -1;
            updateSearchResults();
            return;
        }
        // Adjust currentMatchIndex if necessary
        if (currentMatchIndex >= searchMatches.length) {
            currentMatchIndex = searchMatches.length - 1;
        }
    }

    // Remove current highlight
    if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
        searchMatches[currentMatchIndex].classList.remove('current');
        debugLog(`[Webview] Removed 'current' class from match at index ${currentMatchIndex}`);
    }

    // Calculate new index
    const oldIndex = currentMatchIndex;
    if (direction === 'next') {
        currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
    } else {
        currentMatchIndex = currentMatchIndex <= 0 ? searchMatches.length - 1 : currentMatchIndex - 1;
    }

    debugLog(`[Webview] Index changed from ${oldIndex} to ${currentMatchIndex}`);
    updateCurrentMatch();
}

function updateCurrentMatch() {
    debugLog(`[Webview] updateCurrentMatch called, currentMatchIndex: ${currentMatchIndex}, searchMatches.length: ${searchMatches.length}`);

    if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
        const currentMatch = searchMatches[currentMatchIndex];
        debugLog(`[Webview] Adding 'current' class to match at index ${currentMatchIndex}`);
        debugLog(`[Webview] Current match element:`, currentMatch);
        currentMatch.classList.add('current');

        // Scroll to the current match
        debugLog(`[Webview] Scrolling to current match`);
        currentMatch.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    } else {
        debugLog(`[Webview] Invalid currentMatchIndex: ${currentMatchIndex} (should be between 0 and ${searchMatches.length - 1})`);
    }

    updateSearchResults();
    updateNavigationButtons();
}

function updateSearchResults() {
    if (!findResultsCount) return;

    if (searchMatches.length === 0) {
        if (findInput?.value) {
            // 有搜索词但无匹配结果时显示 0/0
            findResultsCount.textContent = '0/0';
        } else {
            // 无搜索词时显示空字符串
            findResultsCount.textContent = '';
        }
    } else {
        // 有匹配结果时显示当前位置/总数
        findResultsCount.textContent = `${currentMatchIndex + 1}/${searchMatches.length}`;
    }
}

function updateNavigationButtons() {
    const hasMatches = searchMatches.length > 0;
    debugLog(`[Webview] updateNavigationButtons called, hasMatches: ${hasMatches}`);

    if (findPrevBtn) {
        findPrevBtn.disabled = !hasMatches;
        debugLog(`[Webview] Previous button disabled: ${!hasMatches}`);
    } else {
        debugLog("[Webview] Previous button not found");
    }

    if (findNextBtn) {
        findNextBtn.disabled = !hasMatches;
        debugLog(`[Webview] Next button disabled: ${!hasMatches}`);
    } else {
        debugLog("[Webview] Next button not found");
    }
}

function addToSearchHistory(query: string) {
    // Don't add empty queries or duplicates
    if (!query.trim() || searchHistory.includes(query)) {
        return;
    }

    // Remove existing entry if present (to move it to the end)
    const existingIndex = searchHistory.indexOf(query);
    if (existingIndex !== -1) {
        searchHistory.splice(existingIndex, 1);
    }

    // Add to the end
    searchHistory.push(query);

    // Limit history size
    if (searchHistory.length > MAX_SEARCH_HISTORY) {
        searchHistory.shift(); // Remove the oldest entry
    }

    searchHistoryIndex = searchHistory.length - 1;
    debugLog(`[Webview] Added to search history: "${query}", history length: ${searchHistory.length}`);
}

function navigateSearchHistory(direction: 'up' | 'down') {
    if (searchHistory.length === 0) {
        debugLog("[Webview] No search history available");
        return;
    }

    if (direction === 'up') {
        if (searchHistoryIndex > 0) {
            searchHistoryIndex--;
        } else {
            searchHistoryIndex = searchHistory.length - 1; // Wrap to last
        }
    } else {
        if (searchHistoryIndex < searchHistory.length - 1) {
            searchHistoryIndex++;
        } else {
            searchHistoryIndex = 0; // Wrap to first
        }
    }

    const historyQuery = searchHistory[searchHistoryIndex];
    if (findInput && historyQuery) {
        debugLog(`[Webview] Navigating to history item: "${historyQuery}"`);
        findInput.value = historyQuery;
        performSearch();
    }
}

function showSearchHistoryMenu() {
    if (searchHistory.length === 0) {
        debugLog("[Webview] No search history to show");
        return;
    }

    // Create a simple dropdown menu for search history
    const menu = document.createElement('div');
    menu.className = 'search-history-menu';
    menu.style.cssText = `
        position: absolute;
        background: var(--vscode-dropdown-background);
        border: 1px solid var(--vscode-dropdown-border);
        border-radius: 3px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        z-index: 1001;
        max-height: 200px;
        overflow-y: auto;
        min-width: 200px;
    `;

    // Position the menu below the find input
    if (findInput) {
        const inputRect = findInput.getBoundingClientRect();
        menu.style.top = `${inputRect.bottom + 2}px`;
        menu.style.left = `${inputRect.left}px`;
    }

    // Add history items
    searchHistory.slice().reverse().forEach((query, index) => {
        const item = document.createElement('div');
        item.className = 'search-history-item';
        item.textContent = query;
        item.style.cssText = `
            padding: 6px 12px;
            cursor: pointer;
            color: var(--vscode-dropdown-foreground);
            font-size: 13px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        `;

        item.addEventListener('mouseenter', () => {
            item.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
        });

        item.addEventListener('mouseleave', () => {
            item.style.backgroundColor = 'transparent';
        });

        item.addEventListener('click', () => {
            if (findInput) {
                findInput.value = query;
                performSearch();
            }
            document.body.removeChild(menu);
        });

        menu.appendChild(item);
    });

    // Add clear history option
    if (searchHistory.length > 0) {
        const separator = document.createElement('div');
        separator.style.cssText = `
            height: 1px;
            background: var(--vscode-dropdown-border);
            margin: 4px 0;
        `;
        menu.appendChild(separator);

        const clearItem = document.createElement('div');
        clearItem.className = 'search-history-clear';
        clearItem.textContent = '清空历史记录';
        clearItem.style.cssText = `
            padding: 6px 12px;
            cursor: pointer;
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
            font-style: italic;
        `;

        clearItem.addEventListener('mouseenter', () => {
            clearItem.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
        });

        clearItem.addEventListener('mouseleave', () => {
            clearItem.style.backgroundColor = 'transparent';
        });

        clearItem.addEventListener('click', () => {
            searchHistory = [];
            searchHistoryIndex = -1;
            debugLog("[Webview] Search history cleared");
            document.body.removeChild(menu);
        });

        menu.appendChild(clearItem);
    }

    document.body.appendChild(menu);

    // Close menu when clicking outside
    setTimeout(() => {
        const closeMenu = (event: MouseEvent) => {
            if (!menu.contains(event.target as Node)) {
                document.body.removeChild(menu);
                document.removeEventListener('click', closeMenu);
            }
        };
        document.addEventListener('click', closeMenu);
    }, 0);
}

// Add event listeners for history and filter buttons
findHistoryBtn?.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent event bubbling
    debugLog("[Webview] Search history button clicked");
    showSearchHistoryMenu();
});
