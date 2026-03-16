const API_URL = '/api/notes';

let allKnownTags = new Set();
// Tag states for Stack tab
let stackSelectedTags = [];
let stackSuggestionIndex = -1;

// Tag states for Edit tab
let editSelectedTags = [];
let editSuggestionIndex = -1;

let currentViewingNote = null; // Track current opened note
let renderStackTags = null;
let renderEditTags = null;

document.addEventListener('DOMContentLoaded', () => {
    if (typeof markedKatex !== 'undefined') {
        marked.use(markedKatex({ throwOnError: false, strict: false }));
    }

    fetchAllTags();
    setupNavigation();
    
    // Setup Tag Autocomplete for both contexts
    renderStackTags = setupTagManager('input-tags', 'selected-tags', 'tag-suggestions', stackSelectedTags, (idx) => stackSuggestionIndex = idx, () => stackSuggestionIndex);
    renderEditTags = setupTagManager('edit-input-tags', 'edit-selected-tags', 'edit-tag-suggestions', editSelectedTags, (idx) => editSuggestionIndex = idx, () => editSuggestionIndex);
    
    setupDetailEditor();
    setupPasteUpload();
    setupSettingsListeners();
    
    // Duplicate title check (Debounced)
    let titleCheckTimeout = null;
    document.getElementById('input-title').addEventListener('input', (e) => {
        const titleVal = e.target.value.trim();
        const warningEl = document.getElementById('title-duplicate-warning');
        
        if (titleCheckTimeout) clearTimeout(titleCheckTimeout);
        
        if (!titleVal) {
            warningEl.classList.add('hidden');
            return;
        }
        
        titleCheckTimeout = setTimeout(async () => {
            try {
                const res = await fetch(`/api/notes/check_title?title=${encodeURIComponent(titleVal)}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.exists) {
                        const countMsg = data.count > 1 ? `${data.count} stacks with this title exist.` : `Stack already exists.`;
                        warningEl.innerHTML = `<span>${countMsg}</span> <a id="jump-to-edit">Review matches?</a>`;
                        warningEl.classList.remove('hidden');
                        
                        document.getElementById('jump-to-edit').addEventListener('click', async () => {
                            // 1. Switch tab to search
                            document.querySelector('.nav-btn[data-target="tab-search"]').click();
                            
                            // 2. Put the title into the search bar and load
                            const searchInput = document.getElementById('search-input');
                            searchInput.value = titleVal;
                            
                            // 3. Clear stack inputs
                            warningEl.classList.add('hidden');
                            document.getElementById('input-title').value = '';
                            document.getElementById('input-content').value = '';
                            
                            await loadNotes(titleVal);
                            
                            // 4. If exactly 1 match, open detail & edit automatically!
                            const cards = document.querySelectorAll('.note-card');
                            if (cards.length === 1) {
                                cards[0].click(); // Triggers showDetail via the card's listener
                                setTimeout(() => {
                                    const btnEdit = document.getElementById('btn-edit');
                                    if (btnEdit && !btnEdit.classList.contains('hidden')) {
                                        btnEdit.click();
                                    }
                                }, 50); // slight delay to ensure showDetail has finished rendering
                            }
                        });
                    } else {
                        warningEl.classList.add('hidden');
                    }
                }
            } catch(err) {
                console.error('Check title failed', err);
            }
        }, 500);
    });
    
    // Focus default input
    document.getElementById('input-title').focus();
    
    // Setup Event Listeners
    document.getElementById('btn-stack').addEventListener('click', stackNote);
    
    // Alt+Enter or Ctrl+Enter to submit
    document.addEventListener('keydown', (e) => {
        if ((e.altKey || e.ctrlKey) && e.key === 'Enter') {
            stackNote();
        }
    });

    document.getElementById('search-input').addEventListener('input', (e) => {
        loadNotes(e.target.value);
    });
    
    document.getElementById('btn-export').addEventListener('click', exportCSV);
});

// --- Navigation & Drawer Logic ---
function setupNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');
    const tabs = document.querySelectorAll('.tab-content');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    
    // Toggle Drawer
    const toggleDrawer = () => {
        const isOpen = sidebar.classList.contains('open');
        if (isOpen) {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        } else {
            sidebar.classList.add('open');
            overlay.classList.add('active');
        }
    };
    
    document.getElementById('menu-btn').addEventListener('click', toggleDrawer);
    document.getElementById('close-menu-btn').addEventListener('click', toggleDrawer);
    overlay.addEventListener('click', toggleDrawer);

    navBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Update active state on buttons
            navBtns.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            
            // Hide all tabs
            tabs.forEach(t => t.classList.remove('active'));
            
            // Show target tab
            const targetId = e.currentTarget.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');
            
            // Close drawer if it's open
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
            
            // Lazy load data based on selected tab
            if (targetId === 'tab-search') {
                loadNotes(document.getElementById('search-input').value);
            } else if (targetId === 'tab-stats') {
                loadStats();
            } else if (targetId === 'tab-settings') {
                renderSettingsTags();
                loadSyncSettings();
            } else if (targetId === 'tab-stack') {
                document.getElementById('input-title').focus();
            }
        });
    });
}

// --- Tag Autocomplete Logic ---
async function fetchAllTags() {
    try {
        const res = await fetch(API_URL);
        const notes = await res.json();
        notes.forEach(n => {
            n.tags.forEach(t => allKnownTags.add(t));
        });
    } catch (e) {
        console.error(e);
    }
}

function setupTagManager(inputId, chipsContainerId, suggBoxId, tagsArray, setIndex, getIndex) {
    const inputTags = document.getElementById(inputId);
    const suggBox = document.getElementById(suggBoxId);
    if (!inputTags || !suggBox) return;
    
    const wrapper = inputTags.closest('.tag-input-wrapper');
    const renderChips = () => {
        const container = document.getElementById(chipsContainerId);
        container.innerHTML = '';
        tagsArray.forEach(t => {
            const span = document.createElement('span');
            span.className = 'selected-tag-chip';
            span.innerHTML = `#${t} <span class="remove-btn">&times;</span>`;
            span.querySelector('.remove-btn').addEventListener('click', () => {
                tagsArray.splice(tagsArray.indexOf(t), 1);
                renderChips();
            });
            container.appendChild(span);
        });
    };

    inputTags.addEventListener('input', () => {
        const val = inputTags.value.trim().replace(/^#/, '');
        suggBox.innerHTML = '';
        setIndex(-1);
        
        if (val) {
            const matches = Array.from(allKnownTags).filter(t => t.toLowerCase().includes(val.toLowerCase()) && !tagsArray.includes(t));
            if (matches.length > 0) {
                matches.forEach((m, idx) => {
                    const div = document.createElement('div');
                    div.className = 'suggestion-item';
                    div.textContent = m;
                    div.addEventListener('click', () => {
                        tagsArray.push(m);
                        allKnownTags.add(m);
                        renderChips();
                        inputTags.value = '';
                        suggBox.classList.add('hidden');
                        inputTags.focus();
                    });
                    suggBox.appendChild(div);
                });
                suggBox.classList.remove('hidden');
            } else {
                suggBox.classList.add('hidden');
            }
        } else {
            suggBox.classList.add('hidden');
        }
    });
    
    inputTags.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        
        const items = suggBox.querySelectorAll('.suggestion-item');
        let idx = getIndex();
        
        const updateHighlight = () => {
            items.forEach(item => item.classList.remove('active'));
            if (idx > -1 && idx < items.length) {
                items[idx].classList.add('active');
                items[idx].scrollIntoView({block: 'nearest'});
            }
        };

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (idx < items.length - 1) idx++;
            setIndex(idx);
            updateHighlight();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (idx > 0) idx--;
            setIndex(idx);
            updateHighlight();
        } else if (e.key === 'Tab') {
            if (!suggBox.classList.contains('hidden') && items.length > 0) {
                e.preventDefault();
                if (e.shiftKey) {
                    idx = idx > 0 ? idx - 1 : items.length - 1;
                } else {
                    idx = idx < items.length - 1 ? idx + 1 : 0;
                }
                setIndex(idx);
                updateHighlight();
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (suggBox.classList.contains('hidden') || items.length === 0 || idx === -1) {
                const val = inputTags.value.trim().replace(/^#/, '');
                if (val && !tagsArray.includes(val)) {
                    tagsArray.push(val);
                    allKnownTags.add(val);
                    renderChips();
                }
            } else {
                const val = items[idx].textContent;
                if (!tagsArray.includes(val)) {
                    tagsArray.push(val);
                    allKnownTags.add(val);
                    renderChips();
                }
            }
            inputTags.value = '';
            suggBox.classList.add('hidden');
            suggBox.innerHTML = '';
            setIndex(-1);
        } else if (e.key === 'Backspace' && inputTags.value === '') {
            if (tagsArray.length > 0) {
                tagsArray.pop();
                renderChips();
            }
        }
    });

    document.addEventListener('click', (e) => {
        if (wrapper && !wrapper.contains(e.target)) {
            suggBox.classList.add('hidden');
        }
    });
    
    return renderChips;
}

// --- Logic ---
async function loadNotes(query = "") {
    let url = API_URL;
    if (query) {
        url += `?query=${encodeURIComponent(query)}`;
    }
    const res = await fetch(url);
    const notes = await res.json();
    
    const container = document.getElementById('notes-list');
    container.innerHTML = '';
    
    // Update count display
    const countEl = document.getElementById('search-count');
    if (countEl) countEl.textContent = notes.length;
    
    // Hide detail pane when a new search comes in
    document.getElementById('detail-empty').classList.remove('hidden');
    document.getElementById('detail-content').classList.add('hidden');

    notes.forEach(note => {
        const card = document.createElement('div');
        const isIncomplete = !note.content;
        
        card.className = `note-card ${isIncomplete ? 'incomplete' : ''}`;
        
        const tagsHtml = note.tags.slice(0, 3).map(t => `<span class="tag">#${t}</span>`).join('') + (note.tags.length > 3 ? '<span class="tag">...</span>' : '');
        
        let displayContent = note.content || "No content provided.";
        
        const dateStr = new Date(note.created_at).toLocaleDateString();
        const titleHtml = note.title ? `<div class="note-title">${note.title}</div>` : '';
        
        card.innerHTML = `
            <div class="note-header">
                ${titleHtml}
                <span class="note-date">${dateStr}</span>
            </div>
            <div class="note-content ${!note.content ? 'empty' : ''}">${displayContent}</div>
            <div class="note-tags">${tagsHtml}</div>
        `;
        
        // click to interact 
        card.addEventListener('click', () => {
            // Manage UI selected state
            document.querySelectorAll('.note-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            
            // Show details
            currentViewingNote = note;
            showDetail(note);
        });

        container.appendChild(card);
    });
}

function showDetail(note) {
    document.getElementById('detail-empty').classList.add('hidden');
    document.getElementById('detail-content').classList.remove('hidden');
    
    // Reset to viewer state always
    document.getElementById('detail-title').classList.remove('hidden');
    document.getElementById('edit-title').classList.add('hidden');
    
    document.getElementById('detail-tags').classList.remove('hidden');
    document.getElementById('edit-tags-container').classList.add('hidden');
    
    document.getElementById('detail-viewer').classList.remove('hidden');
    document.getElementById('detail-editor').classList.add('hidden');
    
    document.getElementById('btn-edit').classList.remove('hidden');
    document.getElementById('edit-actions-inline').classList.add('hidden');
    
    // Set text contents
    const titleEl = document.getElementById('detail-title');
    if (note.title) {
        titleEl.textContent = note.title;
        titleEl.style.display = 'block';
    } else {
        titleEl.textContent = '';
        titleEl.style.display = 'none';
    }
    
    let dateStr = "Created: " + new Date(note.created_at).toLocaleString();
    if (note.updated_at && note.updated_at !== note.created_at) {
        dateStr += ` (Edited: ${new Date(note.updated_at).toLocaleString()})`;
    }
    document.getElementById('detail-date').textContent = dateStr;
    
    const contentEl = document.getElementById('detail-text');
    if (note.content) {
        // Parse markdown text using marked.js!
        contentEl.innerHTML = marked.parse(note.content, { breaks: true });
        
        // Enhance code blocks with syntax highlighting and Copy buttons
        contentEl.querySelectorAll('pre code').forEach((block) => {
            // Apply Highlighting
            hljs.highlightElement(block);
            
            // Add Copy Button & Wrapper
            const pre = block.parentElement;
            if (!pre.classList.contains('wrapped')) {
                pre.classList.add('wrapped');
                const wrapper = document.createElement('div');
                wrapper.className = 'code-block-wrapper';
                
                const header = document.createElement('div');
                header.className = 'code-header';
                
                // Extract language from classes
                const langClass = Array.from(block.classList).find(c => c.startsWith('language-'));
                const lang = langClass ? langClass.replace('language-', '') : 'text';
                
                header.innerHTML = `
                    <span class="code-lang">${lang}</span>
                    <button class="btn-copy" onclick="copyCode(this)">Copy</button>
                `;
                
                pre.parentNode.insertBefore(wrapper, pre);
                wrapper.appendChild(header);
                wrapper.appendChild(pre);
            }
        });
        
        contentEl.classList.remove('empty');
    } else {
        contentEl.textContent = "No content available.";
        contentEl.classList.add('empty');
    }
    
    document.getElementById('detail-tags').innerHTML = note.tags.map(t => `<span class="tag">#${t}</span>`).join('');
}

function setupDetailEditor() {
    const btnEdit = document.getElementById('btn-edit');
    const btnCancel = document.getElementById('btn-cancel-edit');
    const btnSave = document.getElementById('btn-save-edit');
    
    btnEdit.addEventListener('click', () => {
        if (!currentViewingNote) return;
        
        // Hide Viewer elements, show Seamless Inputs
        document.getElementById('detail-title').classList.add('hidden');
        const editTitle = document.getElementById('edit-title');
        editTitle.classList.remove('hidden');
        editTitle.value = currentViewingNote.title || '';
        
        document.getElementById('detail-tags').classList.add('hidden');
        document.getElementById('edit-tags-container').classList.remove('hidden');
        // Pre-fill tags array and render chips
        editSelectedTags.length = 0;
        currentViewingNote.tags.forEach(t => editSelectedTags.push(t));
        // We need to re-render using a trick or dispatch
        document.getElementById('edit-selected-tags').innerHTML = '';
        editSelectedTags.forEach(t => {
            const span = document.createElement('span');
            span.className = 'selected-tag-chip';
            span.innerHTML = `#${t} <span class="remove-btn">&times;</span>`;
            span.querySelector('.remove-btn').addEventListener('click', () => {
                editSelectedTags.splice(editSelectedTags.indexOf(t), 1);
                span.remove();
            });
            document.getElementById('edit-selected-tags').appendChild(span);
        });
        
        document.getElementById('detail-viewer').classList.add('hidden');
        document.getElementById('detail-editor').classList.remove('hidden');
        document.getElementById('edit-content').value = currentViewingNote.content || '';
        
        btnEdit.classList.add('hidden');
        document.getElementById('edit-actions-inline').classList.remove('hidden');
        
        // Auto focus title
        editTitle.focus();
    });
    
    btnCancel.addEventListener('click', () => {
        showDetail(currentViewingNote);
    });
    
    btnSave.addEventListener('click', async () => {
        if (!currentViewingNote) return;
        
        const newTitle = document.getElementById('edit-title').value.trim();
        const newContent = document.getElementById('edit-content').value.trim();
        const newTags = [...editSelectedTags]; // Clone array
        
        if (!newTitle && !newContent) {
            alert("タイトルかコンテントのどっちかは書いてほしいな……っ！💓");
            return;
        }
        
        const updatedNote = {
            title: newTitle || null,
            content: newContent || null,
            tags: newTags
        };
        
        try {
            const res = await fetch(`${API_URL}/${currentViewingNote.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedNote)
            });
            
            if (res.ok) {
                const refreshedNote = await res.json();
                currentViewingNote = refreshedNote;
                
                // Learn new tags automatically
                newTags.forEach(t => allKnownTags.add(t));
                
                // Reload list in background so timeline updates, but retain search
                const query = document.getElementById('search-input').value;
                await loadNotes(query);
                
                // Keep the detail pane open and re-select the item
                showDetail(currentViewingNote);
                
                // Visually highlight it in the list again
                const cards = Array.from(document.querySelectorAll('.note-card'));
                const myCard = cards.find(c => {
                    return c.querySelector('.note-date').textContent === new Date(currentViewingNote.created_at).toLocaleDateString();
                });
                if(myCard) myCard.classList.add('selected');
                
            } else {
                alert("更新に失敗しちゃった……！");
            }
        } catch(e) {
            console.error(e);
            alert("エラーが発生したよ……！！");
        }
    });
}

function setupPasteUpload() {
    const attachPasteHandler = (textareaId) => {
        const ta = document.getElementById(textareaId);
        if (!ta) return;
        
        ta.addEventListener('paste', async (e) => {
            const items = (e.clipboardData || e.originalEvent.clipboardData).items;
            for (let item of items) {
                if (item.type.indexOf('image') === 0) {
                    e.preventDefault(); // Prevent standard paste
                    const file = item.getAsFile();
                    const formData = new FormData();
                    formData.append('file', file);
                    
                    const caretPos = ta.selectionStart;
                    const before = ta.value.substring(0, caretPos);
                    const after = ta.value.substring(ta.selectionEnd);
                    const placeholder = "![Uploading image...]()";
                    
                    ta.value = before + placeholder + after;
                    
                    try {
                        const res = await fetch('/api/upload', {
                            method: 'POST',
                            body: formData
                        });
                        const data = await res.json();
                        
                        ta.value = ta.value.replace(placeholder, `![image](${data.url})`);
                    } catch(err) {
                        console.error('Upload failed: ', err);
                        ta.value = ta.value.replace(placeholder, "![Upload failed]()");
                    }
                }
            }
        });
    };
    
    attachPasteHandler('input-content');
    attachPasteHandler('edit-content');
}

// Global function for copying code block text
window.copyCode = function(button) {
    const wrapper = button.closest('.code-block-wrapper');
    const codeEl = wrapper.querySelector('code');
    // Using textContent to grab raw text, avoiding HTML tags
    navigator.clipboard.writeText(codeEl.textContent).then(() => {
        const originalText = button.innerText;
        button.innerText = 'Copied! ✨';
        button.style.backgroundColor = 'var(--primary)';
        button.style.color = 'white';
        
        setTimeout(() => {
            button.innerText = originalText;
            button.style.backgroundColor = 'transparent';
            button.style.color = 'var(--primary)';
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
};

async function stackNote() {
    const title = document.getElementById('input-title').value.trim();
    const content = document.getElementById('input-content').value.trim();
    
    if (!title && !content) {
        alert("タイトルかコンテントのどっちかは書いてほしいな……っ！💓");
        return;
    }
    
    // If there is lingering tag text, tag it immediately before stack
    const pendingTag = document.getElementById('input-tags').value.trim().replace(/^#/, '');
    if (pendingTag && !stackSelectedTags.includes(pendingTag)) {
        stackSelectedTags.push(pendingTag);
        allKnownTags.add(pendingTag);
    }
    
    const note = {
        title: title || null,
        content: content || null,
        tags: stackSelectedTags
    };
    
    const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(note)
    });
    
    if (res.ok) {
        // Clear input
        document.getElementById('input-title').value = '';
        document.getElementById('input-content').value = '';
        document.getElementById('input-tags').value = '';
        
        // Clear tags
        stackSelectedTags.length = 0;
        if (renderStackTags) renderStackTags();
        
        // Show cute toast
        showToast("Stacked successfully! ✨");
        
        // focus back on title
        document.getElementById('input-title').focus();
    } else {
        alert("保存に失敗しちゃった……！");
    }
}

async function loadStats() {
    try {
        const res = await fetch(API_URL);
        const notes = await res.json();
        
        const getLocalDateStr = (date) => {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        };

        const todayStr = getLocalDateStr(new Date());
        const todayCount = notes.filter(n => n.created_at.startsWith(todayStr)).length;
        
        document.getElementById('today-count').textContent = todayCount;
        document.getElementById('total-count').textContent = notes.length;

        // Calculate Streak & Heatmap data
        const dayCounts = {};
        notes.forEach(n => {
            const d = n.created_at.split('T')[0];
            dayCounts[d] = (dayCounts[d] || 0) + 1;
        });

        // Current Streak Calculation
        let streak = 0;
        let checkDate = new Date();
        // If nothing today, start checking from yesterday to allow streak to continue
        if (!dayCounts[getLocalDateStr(checkDate)]) {
            checkDate.setDate(checkDate.getDate() - 1);
        }
        
        while (dayCounts[getLocalDateStr(checkDate)]) {
            streak++;
            checkDate.setDate(checkDate.getDate() - 1);
        }
        document.getElementById('streak-count').textContent = streak;

        renderHeatmap(dayCounts);
    } catch(err) {
        console.error('Failed to load stats', err);
    }
}

function renderHeatmap(dayCounts) {
    const container = document.getElementById('heatmap');
    container.innerHTML = '';
    
    const weeksToShow = 20; 
    const now = new Date();
    
    // Fill until the end of this week (Sat)
    const endDate = new Date(now);
    endDate.setDate(now.getDate() + (6 - now.getDay()));
    
    const startDate = new Date(endDate);
    startDate.setDate(endDate.getDate() - (weeksToShow * 7) + 1);

    const getLocalDateStr = (date) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dStr = getLocalDateStr(d);
        const count = dayCounts[dStr] || 0;
        
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        cell.title = `${dStr}: ${count} stack${count === 1 ? '' : 's'}`;
        
        if (count > 0) {
            let level = 1;
            if (count > 2) level = 2;
            if (count > 5) level = 3;
            if (count > 10) level = 4;
            cell.classList.add(`active-${level}`);
        }
        container.appendChild(cell);
    }
}

async function renderSettingsTags() {
    const res = await fetch(API_URL);
    const notes = await res.json();
    
    const tagCounts = {};
    notes.forEach(n => {
        n.tags.forEach(t => {
            tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
    });
    
    // Sort by count descending
    const sortedTags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]);
    
    const container = document.getElementById('settings-tags-list');
    container.innerHTML = '';
    
    if (sortedTags.length === 0) {
        container.innerHTML = '<p class="text-muted">No tags exist yet.</p>';
        return;
    }
    
    sortedTags.forEach(tag => {
        const div = document.createElement('div');
        div.className = 'settings-tag-item';
        div.innerHTML = `
            <span>#${tag}</span>
            <span class="tag-count" title="${tagCounts[tag]} stacks used">${tagCounts[tag]}</span>
            <button class="delete-tag-btn" title="Delete this tag">&times;</button>
        `;
        
        div.querySelector('.delete-tag-btn').addEventListener('click', async () => {
            if (confirm(`Are you sure you want to completely delete the tag "#${tag}"?\n(It will be removed from ${tagCounts[tag]} stack(s)!)`)) {
                try {
                    const delRes = await fetch(`/api/tags/${encodeURIComponent(tag)}`, {
                        method: 'DELETE'
                    });
                    if (delRes.ok) {
                        // Remove from autocomplete state
                        allKnownTags.delete(tag);
                        
                        // Re-render
                        renderSettingsTags();
                        
                        showToast(`Successfully deleted the tag "#${tag}". 🗑️✨`);
                    } else {
                        alert("Sorry, an error occurred while trying to delete the tag.");
                    }
                } catch(err) {
                    console.error('Failed to delete tag', err);
                }
            }
        });
        container.appendChild(div);
    });
}

function setupSettingsListeners() {
    document.getElementById('btn-save-sync-settings').addEventListener('click', saveSyncSettings);
    document.getElementById('btn-sync-push').addEventListener('click', pushToGithub);
    document.getElementById('btn-sync-pull').addEventListener('click', pullFromGithub);
}

async function loadSyncSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.github_token) document.getElementById('setting-github-token').value = data.github_token;
        if (data.github_repo) document.getElementById('setting-github-repo').value = data.github_repo;
    } catch (err) {
        console.error('Failed to load settings', err);
    }
}

async function saveSyncSettings() {
    const token = document.getElementById('setting-github-token').value.trim();
    const repo = document.getElementById('setting-github-repo').value.trim();
    
    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ github_token: token, github_repo: repo })
        });
        if (res.ok) {
            showToast("Sync settings saved! 💾✨");
        }
    } catch (err) {
        alert("Failed to save settings.");
    }
}

async function pushToGithub() {
    const btn = document.getElementById('btn-sync-push');
    const originalText = btn.innerText;
    btn.innerText = "⏳ Pushing...";
    btn.disabled = true;
    
    try {
        const res = await fetch('/api/sync/push', { method: 'POST' });
        if (res.ok) {
            showToast("Backup pushed to GitHub successfully! ☁️🚀");
        } else {
            const data = await res.json();
            alert("Push failed: " + (data.detail || "Unknown error"));
        }
    } catch (err) {
        alert("Network error during push.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function pullFromGithub() {
    if (!confirm("⚠️ CAUTION: This will OVERWRITE all your local stacks with the data from GitHub. Are you sure?")) {
        return;
    }
    
    const btn = document.getElementById('btn-sync-pull');
    const originalText = btn.innerText;
    btn.innerText = "⏳ Pulling...";
    btn.disabled = true;
    
    try {
        const res = await fetch('/api/sync/pull', { method: 'POST' });
        if (res.ok) {
            showToast("Data restored from GitHub! 📥✨");
            // Reload all tags and view
            fetchAllTags();
            loadStats();
            renderSettingsTags();
        } else {
            const data = await res.json();
            alert("Pull failed: " + (data.detail || "Unknown error"));
        }
    } catch (err) {
        alert("Network error during pull.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

function showToast(message) {
    const toast = document.getElementById('app-toast');
    if (!toast) return;
    
    toast.textContent = message;
    toast.classList.remove('hidden');
    
    // Auto hide after 3 seconds
    setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}

async function exportCSV() {
    const res = await fetch(API_URL);
    const notes = await res.json();
    
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
    csvContent += "ID,Title,Content,Tags,Date\n";
    
    notes.forEach(note => {
        const title = `"${(note.title || "").replace(/"/g, '""')}"`;
        const content = `"${(note.content || "").replace(/"/g, '""')}"`;
        const tags = `"${note.tags.join(', ')}"`;
        const date = `"${note.created_at}"`;
        csvContent += `${note.id},${title},${content},${tags},${date}\n`;
    });
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "moca_stack_export.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
