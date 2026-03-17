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

const switchView = (targetMode) => {
    const tabSearch = document.getElementById('tab-search');
    const viewBtns = document.querySelectorAll('.view-btn');
    if (!tabSearch) return;

    // Remove existing layout classes
    tabSearch.classList.remove('is-grid', 'is-focus');
    viewBtns.forEach(b => b.classList.remove('active'));

    if (targetMode === 'grid') {
        tabSearch.classList.add('is-grid');
        const btn = document.getElementById('view-grid');
        if (btn) btn.classList.add('active');
    } else if (targetMode === 'focus') {
        tabSearch.classList.add('is-focus');
        const btn = document.getElementById('view-focus');
        if (btn) btn.classList.add('active');
    } else {
        const btn = document.getElementById('view-standard');
        if (btn) btn.classList.add('active');
    }
};

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
    setupViewSwitcher();
    
    // Default focus
    document.getElementById('input-title').focus();
    
    // Setup Event Listeners
    document.getElementById('btn-stack').addEventListener('click', stackNote);
    
    // Keyboard shortcuts & Navigation
    document.addEventListener('keydown', (e) => {
        // 1. Submit note (Alt/Ctrl + Enter)
        if ((e.altKey || e.ctrlKey) && e.key === 'Enter') {
            stackNote();
            return;
        }

        // 2. List Navigation (Search Tab only, and not in Focus mode)
        const searchTab = document.querySelector('#tab-search.active');
        if (searchTab && !searchTab.classList.contains('is-focus')) {
            const activeEl = document.activeElement;
            // Block if typing in any input/textarea
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;

            if (e.key === 'j' || e.key === 'k') {
                const cards = Array.from(document.querySelectorAll('.note-card'));
                if (cards.length === 0) return;

                const currentIndex = cards.findIndex(c => c.classList.contains('selected'));
                let targetIndex;

                if (e.key === 'j') { // Down
                    targetIndex = Math.min(currentIndex + 1, cards.length - 1);
                } else { // Up (k)
                    targetIndex = Math.max(currentIndex - 1, 0);
                }

                const targetCard = cards[targetIndex];
                if (targetCard) {
                    targetCard.click();
                    targetCard.focus();
                    targetCard.scrollIntoView({ behavior: 'auto', block: 'nearest' });
                }
            }
        }
    }, true); 

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
            navBtns.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            tabs.forEach(t => t.classList.remove('active'));
            const targetId = e.currentTarget.getAttribute('data-target');
            document.getElementById(targetId).classList.add('active');
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
            
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

function setupViewSwitcher() {
    const backBtn = document.getElementById('btn-back-to-list');

    if (document.getElementById('view-standard')) {
        document.getElementById('view-standard').addEventListener('click', () => switchView('standard'));
        document.getElementById('view-grid').addEventListener('click', () => switchView('grid'));
        document.getElementById('view-focus').addEventListener('click', () => {
            if (currentViewingNote) switchView('focus');
            else {
                showToast("Select a stack first to use Focus View! 🌸");
                switchView('standard');
            }
        });
    }

    if (backBtn) {
        backBtn.addEventListener('click', () => {
            switchView('standard');
        });
    }
}

// --- Tag Autocomplete Logic ---
async function fetchAllTags() {
    try {
        const res = await fetch(API_URL);
        const notes = await res.json();
        allKnownTags.clear();
        notes.forEach(n => n.tags.forEach(t => allKnownTags.add(t)));
    } catch(err) {
        console.error('Failed to fetch tags', err);
    }
}

function setupTagManager(inputId, selectedContainerId, suggestionsId, stateArray, setSuggIdx, getSuggIdx) {
    const input = document.getElementById(inputId);
    const container = document.getElementById(selectedContainerId);
    const suggBox = document.getElementById(suggestionsId);
    const wrapper = input.parentElement;

    const renderChips = () => {
        container.innerHTML = '';
        stateArray.forEach((tag, idx) => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.innerHTML = `${tag} <span class="remove">&times;</span>`;
            chip.querySelector('.remove').addEventListener('click', () => {
                stateArray.splice(idx, 1);
                renderChips();
            });
            container.appendChild(chip);
        });
    };

    const showSuggestions = (val) => {
        const filtered = Array.from(allKnownTags)
            .filter(t => t.toLowerCase().includes(val.toLowerCase()) && !stateArray.includes(t))
            .slice(0, 5);
        
        if (filtered.length === 0) {
            suggBox.classList.add('hidden');
            return;
        }

        suggBox.innerHTML = '';
        filtered.forEach((tag, idx) => {
            const item = document.createElement('div');
            item.className = 'suggestion-item' + (idx === getSuggIdx() ? ' active' : '');
            item.textContent = tag;
            item.addEventListener('click', () => {
                stateArray.push(tag);
                input.value = '';
                suggBox.classList.add('hidden');
                renderChips();
            });
            suggBox.appendChild(item);
        });
        suggBox.classList.remove('hidden');
    };

    input.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (val) {
            setSuggIdx(-1);
            showSuggestions(val);
        } else {
            suggBox.classList.add('hidden');
        }
    });

    input.addEventListener('keydown', (e) => {
        const items = suggBox.querySelectorAll('.suggestion-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSuggIdx((getSuggIdx() + 1) % items.length);
            showSuggestions(input.value.trim());
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSuggIdx((getSuggIdx() - 1 + items.length) % items.length);
            showSuggestions(input.value.trim());
        } else if (e.key === 'Enter') {
            if (getSuggIdx() >= 0 && items[getSuggIdx()]) {
                e.preventDefault();
                items[getSuggIdx()].click();
            } else if (input.value.trim()) {
                e.preventDefault();
                const newTag = input.value.trim().replace(/^#/, '');
                if (!stateArray.includes(newTag)) {
                    stateArray.push(newTag);
                    allKnownTags.add(newTag);
                }
                input.value = '';
                suggBox.classList.add('hidden');
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
    
    const countEl = document.getElementById('search-count');
    if (countEl) countEl.textContent = notes.length;
    
    document.getElementById('detail-empty').classList.remove('hidden');
    document.getElementById('detail-content').classList.add('hidden');

    notes.forEach(note => {
        const card = document.createElement('div');
        const isIncomplete = !note.content;
        card.className = `note-card ${isIncomplete ? 'incomplete' : ''}`;
        card.setAttribute('tabindex', '0');
        
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
        
        card.addEventListener('click', () => {
            document.querySelectorAll('.note-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            currentViewingNote = note;
            showDetail(note);

            const tabSearch = document.getElementById('tab-search');
            if (tabSearch && tabSearch.classList.contains('is-grid')) {
                switchView('focus');
            }
        });

        container.appendChild(card);
    });
}

function showDetail(note) {
    document.getElementById('detail-empty').classList.add('hidden');
    document.getElementById('detail-content').classList.remove('hidden');
    
    document.getElementById('detail-title').classList.remove('hidden');
    document.getElementById('edit-title').classList.add('hidden');
    document.getElementById('detail-tags').classList.remove('hidden');
    document.getElementById('edit-tags-container').classList.add('hidden');
    document.getElementById('detail-viewer').classList.remove('hidden');
    document.getElementById('detail-editor').classList.add('hidden');
    document.getElementById('btn-edit').classList.remove('hidden');
    document.getElementById('edit-actions-inline').classList.add('hidden');
    
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
        contentEl.innerHTML = marked.parse(note.content, { breaks: true });
        contentEl.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);
            const pre = block.parentElement;
            if (!pre.classList.contains('wrapped')) {
                pre.classList.add('wrapped');
                const wrapper = document.createElement('div');
                wrapper.className = 'code-wrapper';
                pre.parentNode.insertBefore(wrapper, pre);
                wrapper.appendChild(pre);

                const copyBtn = document.createElement('button');
                copyBtn.className = 'copy-code-btn';
                copyBtn.textContent = 'Copy';
                wrapper.appendChild(copyBtn);

                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(block.innerText);
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => copyBtn.textContent = 'Copy', 2000);
                });
            }
        });
    } else {
        contentEl.innerHTML = '<p class="empty">No content provided for this stack.</p>';
    }

    const tagsEl = document.getElementById('detail-tags');
    tagsEl.innerHTML = '';
    note.tags.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = '#' + tag;
        tagsEl.appendChild(span);
    });
}

async function stackNote() {
    const title = document.getElementById('input-title').value.trim();
    const content = document.getElementById('input-content').value.trim();
    
    if (!title && !content) {
        alert("タイトルか中身、どちらかは入力してねっ！🌸");
        return;
    }

    const note = {
        title: title,
        content: content,
        tags: stackSelectedTags
    };

    const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(note)
    });
    
    if (res.ok) {
        document.getElementById('input-title').value = '';
        document.getElementById('input-content').value = '';
        document.getElementById('input-tags').value = '';
        stackSelectedTags.length = 0;
        if (renderStackTags) renderStackTags();
        showToast("Stacked successfully! ✨");
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

        const dayCounts = {};
        notes.forEach(n => {
            const d = n.created_at.split('T')[0];
            dayCounts[d] = (dayCounts[d] || 0) + 1;
        });

        let streak = 0;
        let checkDate = new Date();
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
                    const delRes = await fetch(`/api/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
                    if (delRes.ok) {
                        allKnownTags.delete(tag);
                        renderSettingsTags();
                        showToast(`Successfully deleted the tag "#${tag}". 🗑️✨`);
                    }
                } catch(err) { console.error('Failed to delete tag', err); }
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
    } catch(err) { console.error('Failed to load settings', err); }
}

async function saveSyncSettings() {
    const token = document.getElementById('setting-github-token').value;
    const repo = document.getElementById('setting-github-repo').value;
    const btn = document.getElementById('btn-save-sync-settings');
    const originalText = btn.innerText;

    try {
        btn.innerText = "⏳ Saving...";
        btn.disabled = true;
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ github_token: token, github_repo: repo })
        });
        if (res.ok) showToast("Sync settings saved! 💾✨");
        else alert("Failed to save settings.");
    } catch(err) {
        console.error('Failed to save settings', err);
        alert("Failed to save settings.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function pushToGithub() {
    const btn = document.getElementById('btn-sync-push');
    const originalText = btn.innerText;
    try {
        btn.innerText = "⏳ Pushing...";
        btn.disabled = true;
        const res = await fetch('/api/sync/push', { method: 'POST' });
        if (res.ok) showToast("Successfully pushed to GitHub! ☁️🚀");
        else alert("Push failed. Check your settings.");
    } catch(err) {
        console.error('Sync failed', err);
        alert("Network error during sync.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function pullFromGithub() {
    if (!confirm("Warning: This will overwrite ALL local data with the version from GitHub. Are you sure?")) return;
    const btn = document.getElementById('btn-sync-pull');
    const originalText = btn.innerText;
    try {
        btn.innerText = "⏳ Pulling...";
        btn.disabled = true;
        const res = await fetch('/api/sync/pull', { method: 'POST' });
        if (res.ok) {
            showToast("Successfully restored from GitHub! ☁️📥");
            renderSettingsTags();
            loadSyncSettings();
            loadStats();
        } else alert("Pull failed. Check your settings.");
    } catch(err) {
        console.error('Sync failed', err);
        alert("Network error during sync.");
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
    setTimeout(() => { toast.classList.add('hidden'); }, 3000);
}

async function exportCSV() {
    const res = await fetch(API_URL);
    const notes = await res.json();
    if (notes.length === 0) { alert("No notes to export!"); return; }
    let csv = "id,title,content,tags,created_at\n";
    notes.forEach(n => {
        const row = [ n.id, n.title || "", n.content || "", n.tags.join(";"), n.created_at ];
        csv += row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",") + "\n";
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `knowlet_export_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
}

function setupDetailEditor() {
    const btnEdit = document.getElementById('btn-edit');
    const btnCancel = document.getElementById('btn-cancel-edit');
    const btnSave = document.getElementById('btn-save-edit');
    const editActions = document.getElementById('edit-actions-inline');

    btnEdit.addEventListener('click', () => {
        if (!currentViewingNote) return;
        document.getElementById('detail-title').classList.add('hidden');
        document.getElementById('edit-title').classList.remove('hidden');
        document.getElementById('edit-title').value = currentViewingNote.title || "";
        document.getElementById('detail-tags').classList.add('hidden');
        document.getElementById('edit-tags-container').classList.remove('hidden');
        editSelectedTags.length = 0;
        currentViewingNote.tags.forEach(t => editSelectedTags.push(t));
        if (renderEditTags) renderEditTags();
        document.getElementById('detail-viewer').classList.add('hidden');
        document.getElementById('detail-editor').classList.remove('hidden');
        document.getElementById('edit-content').value = currentViewingNote.content || "";
        btnEdit.classList.add('hidden');
        editActions.classList.remove('hidden');
        document.getElementById('edit-content').focus();
    });

    btnCancel.addEventListener('click', () => {
        if (currentViewingNote) showDetail(currentViewingNote);
    });

    btnSave.addEventListener('click', async () => {
        if (!currentViewingNote) return;
        const newTitle = document.getElementById('edit-title').value.trim();
        const newContent = document.getElementById('edit-content').value.trim();
        const updated = {
            title: newTitle,
            content: newContent,
            tags: editSelectedTags
        };
        const res = await fetch(`${API_URL}/${currentViewingNote.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updated)
        });
        if (res.ok) {
            const savedNote = await res.json();
            currentViewingNote = savedNote;
            showDetail(savedNote);
            showToast("Stack updated! ✨");
            loadNotes(document.getElementById('search-input').value);
        } else { alert("Failed to save changes."); }
    });
}

function setupPasteUpload() {
    const editor = document.getElementById('edit-content');
    const stackContent = document.getElementById('input-content');
    
    const handlePaste = async (e, textarea) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                const formData = new FormData();
                formData.append('file', file);
                const res = await fetch('/api/upload', { method: 'POST', body: formData });
                if (res.ok) {
                    const data = await res.json();
                    const url = data.url;
                    const pos = textarea.selectionStart;
                    const text = textarea.value;
                    const md = `\n![image](${url})\n`;
                    textarea.value = text.substring(0, pos) + md + text.substring(pos);
                    showToast("Image uploaded! 📸");
                }
            }
        }
    };

    if (editor) editor.addEventListener('paste', (e) => handlePaste(e, editor));
    if (stackContent) stackContent.addEventListener('paste', (e) => handlePaste(e, stackContent));
}
