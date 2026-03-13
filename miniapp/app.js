// OpenClaw Canvas Mini App
// Vanilla JS client for Telegram WebApp

(() => {
  // Global error handler for debugging
  window.addEventListener('error', (e) => {
    console.error('[Canvas] Global error:', e.error);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[Canvas] Unhandled promise rejection:', e.reason);
  });

  const tg = window.Telegram?.WebApp;
  // Apply Telegram theme (light/dark)
  try {
    const theme = tg?.colorScheme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_) {}

  // DOM elements - will be null if DOM not ready
  let contentEl = null;
  let connDot = null;
  let connText = null;
  let lastUpdatedEl = null;
  let openTerminalBtn = null;
  let closeTerminalBtn = null;
  let openFilesBtn = null;
  let closeFilesBtn = null;
  let editorBackBtn = null;
  let editorSaveBtn = null;
  let openHomeBtn = null;

  function initDOMElements() {
    contentEl = document.querySelector('.content-inner');
    connDot = document.getElementById('connDot');
    connText = document.getElementById('connText');
    lastUpdatedEl = document.getElementById('lastUpdated');
    openTerminalBtn = document.getElementById('openTerminalBtn');
    closeTerminalBtn = document.getElementById('closeTerminalBtn');
    openFilesBtn = document.getElementById('openFilesBtn');
    closeFilesBtn = document.getElementById('closeFilesBtn');
    editorBackBtn = document.getElementById('editorBackBtn');
    editorSaveBtn = document.getElementById('editorSaveBtn');
    editorSearchBtn = document.getElementById('editorSearchBtn');
    findPanel = document.getElementById('find-panel');
    findInput = document.getElementById('find-input');
    findPrevBtn = document.getElementById('find-prev-btn');
    findNextBtn = document.getElementById('find-next-btn');
    findCloseBtn = document.getElementById('find-close-btn');
    findStatus = document.getElementById('find-status');
    openHomeBtn = document.getElementById('openHomeBtn');
    // Search elements
    searchInput = document.getElementById('searchInput');
    searchType = document.getElementById('searchType');
    searchExt = document.getElementById('searchExt');
    searchBtn = document.getElementById('searchBtn');
    clearSearchBtn = document.getElementById('clearSearchBtn');
    console.log('[Canvas] DOM elements initialized');
  }

  let jwt = null;
  let ws = null;
  let reconnectTimer = null;
  let lastUpdatedTs = null;
  let relativeTimer = null;

  // ---------- File Browser State ----------
  let currentPath = '.';
  let editorInstance = null;
  let currentEditorFile = null;
  let fileRootPath = '.';

  // Find in file state
  let findMatches = [];
  let currentMatchIndex = -1;

  // Search elements
  let searchInput = null;
  let searchType = null;
  let searchExt = null;
  let searchBtn = null;
  let clearSearchBtn = null;

  // Find in file elements
  let editorSearchBtn = null;
  let findPanel = null;
  let findInput = null;
  let findPrevBtn = null;
  let findNextBtn = null;
  let findCloseBtn = null;
  let findStatus = null;

  // Quick commands
  let quickCommands = [];

  // ---------- Search Functions ----------
  async function performSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchType = document.getElementById('searchType');
    const searchExt = document.getElementById('searchExt');
    const searchResults = document.getElementById('search-results');
    const fileTree = document.getElementById('file-tree');

    const query = searchInput.value.trim();
    if (!query) {
      searchResults.style.display = 'none';
      fileTree.style.display = 'block';
      return;
    }

    searchResults.innerHTML = '<div class="files-loading"><div class="spinner"></div>Searching...</div>';
    searchResults.style.display = 'block';
    fileTree.style.display = 'none';

    try {
      const url = `/fs/search?q=${encodeURIComponent(query)}&type=${searchType.value}&ext=${searchExt.value}&token=${encodeURIComponent(jwt)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();

      if (data.results.length === 0) {
        searchResults.innerHTML = `<div class="files-empty">No results for "${escapeHtml(query)}"</div>`;
        return;
      }

      let html = `<div class="search-results-header">Found ${data.count} result${data.count !== 1 ? 's' : ''} for "${escapeHtml(query)}"</div>`;
      
      data.results.forEach(item => {
        const icon = getFileIcon(item.name);
        html += `
          <div class="search-result-item" data-path="${escapeHtml(item.path)}">
            <div class="search-result-header">
              <span class="search-result-icon">${icon}</span>
              <div class="search-result-info">
                <div class="search-result-name">${escapeHtml(item.name)}</div>
                <div class="search-result-path">${escapeHtml(item.path)}</div>
              </div>
              <span class="search-match-badge">${item.matchType}</span>
            </div>
        `;

        if (item.matchLines && item.matchLines.length > 0) {
          html += '<div class="search-result-lines">';
          item.matchLines.forEach(line => {
            // Highlight matched text
            const highlighted = highlightMatch(line.content, query);
            html += `
              <div class="search-result-line">
                <span class="line-number">${line.line}</span>
                <span class="line-content">${highlighted}</span>
              </div>
            `;
          });
          html += '</div>';
        }

        html += '</div>';
      });

      searchResults.innerHTML = html;

      // Add click handlers
      searchResults.querySelectorAll('.search-result-item').forEach(item => {
        item.onclick = () => {
          const path = item.dataset.path;
          openFile(path);
        };
      });
    } catch (err) {
      searchResults.innerHTML = `<div class="files-empty">Error: ${err.message}</div>`;
    }
  }

  function highlightMatch(text, query) {
    const escaped = escapeHtml(text);
    const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
    return escaped.replace(regex, '<mark>$1</mark>');
  }

  function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function clearSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('search-results');
    const fileTree = document.getElementById('file-tree');
    
    searchInput.value = '';
    searchResults.style.display = 'none';
    fileTree.style.display = 'block';
  }

  // ---------- File Browser Functions ----------
  function normalizeFilePath(inputPath) {
    const raw = String(inputPath || '.').trim();
    if (!raw || raw === '.') return '.';
    const isAbsolute = raw.startsWith('/');
    const parts = [];
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (parts.length) {
          parts.pop();
        } else if (!isAbsolute) {
          parts.push('..');
        }
        continue;
      }
      parts.push(part);
    }
    if (isAbsolute) return `/${parts.join('/')}` || '/';
    return parts.join('/') || '.';
  }

  async function loadDirectory(path, { allowFallback = true } = {}) {
    currentPath = normalizeFilePath(path);
    const pathEl = document.getElementById('currentPath');
    if (pathEl) pathEl.textContent = currentPath;

    const treeEl = document.getElementById('file-tree');
    treeEl.innerHTML = '<div class="files-loading"><div class="spinner"></div>Loading...</div>';

    try {
      const res = await fetch(`/fs/tree?path=${encodeURIComponent(currentPath)}&token=${encodeURIComponent(jwt)}`);
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || 'Failed to load');
      }
      const data = await res.json();
      fileRootPath = normalizeFilePath(data.workspaceRoot || fileRootPath || '.');
      currentPath = normalizeFilePath(data.path || currentPath);
      if (pathEl) pathEl.textContent = currentPath;

      treeEl.innerHTML = '';
      
      // Add ".." for going up
      if (currentPath !== '.' && currentPath !== '/') {
        const upItem = document.createElement('div');
        upItem.className = 'file-item dir';
        upItem.innerHTML = '<span class="file-item-icon">📁</span><span class="file-item-name">..</span>';
        upItem.onclick = () => {
          loadDirectory(normalizeFilePath(`${currentPath}/..`));
        };
        treeEl.appendChild(upItem);
      }

      if (!data.items || data.items.length === 0) {
        treeEl.innerHTML = '<div class="files-empty">Empty directory</div>';
        return;
      }

      data.items.forEach(item => {
        const el = document.createElement('div');
        el.className = `file-item ${item.type}`;
        const icon = item.type === 'dir' ? '📁' : getFileIcon(item.name);
        el.innerHTML = `<span class="file-item-icon">${icon}</span><span class="file-item-name">${escapeHtml(item.name)}</span>`;
        el.onclick = () => {
          if (item.type === 'dir') {
            loadDirectory(item.path);
          } else {
            openFile(item.path);
          }
        };
        treeEl.appendChild(el);
      });
    } catch (err) {
      if (allowFallback && currentPath !== fileRootPath) {
        return loadDirectory(fileRootPath, { allowFallback: false });
      }
      treeEl.innerHTML = `<div class="files-empty">${escapeHtml(err.message || 'No files available')}</div>`;
    }
  }

  function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
      js: '📜', ts: '📜', py: '🐍', sh: '💻', bash: '💻',
      json: '📋', yaml: '📋', yml: '📋', toml: '📋',
      md: '📝', txt: '📄', log: '📄',
      html: '🌐', css: '🎨', scss: '🎨',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
      mp3: '🎵', mp4: '🎬', wav: '🎵',
      zip: '📦', tar: '📦', gz: '📦',
      pdf: '📕', doc: '📘', docx: '📘',
    };
    return icons[ext] || '📄';
  }

  async function openFile(path) {
    console.log('[Canvas] openFile called with:', path);
    const editorPane = document.getElementById('editor-pane');
    const editorTitle = document.getElementById('editorTitle');
    const editorStatus = document.getElementById('editor-status');
    const editorContainer = document.getElementById('editor-container');

    if (!editorPane || !editorContainer) {
      console.error('[Canvas] Editor elements not found');
      alert('Editor not ready. Please refresh the page.');
      return;
    }

    editorTitle.textContent = path.split('/').pop();
    editorStatus.textContent = 'Loading...';
    editorPane.style.display = 'flex';

    try {
      const res = await fetch(`/fs/read?path=${encodeURIComponent(path)}&token=${encodeURIComponent(jwt)}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to load file');
      }
      const data = await res.json();
      console.log('[Canvas] File loaded:', path, 'size:', data.content?.length, 'bytes');

      currentEditorFile = path;

      // Wait for CodeMirror to be available
      if (typeof CodeMirror === 'undefined') {
        console.error('[Canvas] CodeMirror not loaded');
        editorStatus.textContent = 'Error: CodeMirror not loaded';
        return;
      }

      // Initialize CodeMirror if not already
      if (!editorInstance) {
        console.log('[Canvas] Initializing CodeMirror...');
        editorInstance = CodeMirror(editorContainer, {
          value: data.content || '',
          mode: getMode(path),
          theme: 'default',
          lineNumbers: true,
          indentUnit: 2,
          tabSize: 2,
          indentWithTabs: false,
          lineWrapping: true,
          extraKeys: {
            'Ctrl-S': saveFile,
            'Cmd-S': saveFile,
          },
        });
        console.log('[Canvas] CodeMirror initialized');
      } else {
        editorInstance.setValue(data.content || '');
        editorInstance.setOption('mode', getMode(path));
        console.log('[Canvas] CodeMirror updated');
      }

      editorStatus.textContent = `${data.content?.length || 0} bytes`;
      editorInstance.clearHistory(); // Clear undo history for new file
    } catch (err) {
      console.error('[Canvas] openFile error:', err);
      editorStatus.textContent = `Error: ${err.message}`;
    }
  }

  function getMode(path) {
    const ext = path.split('.').pop().toLowerCase();
    const modes = {
      js: 'javascript', ts: 'javascript', mjs: 'javascript', cjs: 'javascript',
      py: 'python',
      sh: 'shell', bash: 'shell',
      json: { name: 'javascript', json: true },
      yaml: 'yaml', yml: 'yaml',
      md: 'markdown',
      html: 'htmlmixed', htm: 'htmlmixed',
      css: 'css', scss: 'css',
    };
    return modes[ext] || 'text';
  }

  async function saveFile() {
    console.log('[Canvas] saveFile called, file:', currentEditorFile);
    if (!currentEditorFile || !editorInstance) {
      console.error('[Canvas] saveFile: no file or editor instance');
      return;
    }

    const editorStatus = document.getElementById('editor-status');
    editorStatus.textContent = 'Saving...';

    try {
      const content = editorInstance.getValue();
      console.log('[Canvas] Saving file, content length:', content.length);
      
      const res = await fetch(`/fs/write?token=${encodeURIComponent(jwt)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: currentEditorFile,
          content: content,
        }),
      });

      const result = await res.json().catch(() => ({}));
      console.log('[Canvas] Save response:', res.status, result);

      if (!res.ok) throw new Error(result.error || 'Failed to save');
      editorStatus.textContent = 'Saved!';
      setTimeout(() => {
        editorStatus.textContent = `${content.length} bytes`;
      }, 2000);
    } catch (err) {
      console.error('[Canvas] saveFile error:', err);
      editorStatus.textContent = `Error: ${err.message}`;
    }
  }

  function closeEditor() {
    document.getElementById('editor-pane').style.display = 'none';
    if (editorInstance) {
      editorInstance.setValue('');
    }
    currentEditorFile = null;
    hideFindPanel();
  }

  // ---------- Quick Commands Functions ----------
  function executeQuickCommand(cmd) {
    console.log('[Canvas] Execute quick command:', cmd);
    
    if (cmd.type === 'navigate') {
      // Navigate to files with specific path
      showFileBrowser();
      loadDirectory(cmd.path);
    } else if (cmd.type === 'exec') {
      runQuickCommand(cmd);
    } else if (cmd.type === 'terminal') {
      openTerminalAndRun(cmd.command || '');
    }
  }

  async function runQuickCommand(cmd) {
    if (!cmd?.id) return;
    showCenter(`Running: ${cmd.label || cmd.id}...`, true, null, null, false);
    try {
      const res = await fetch(`/api/commands/run?token=${encodeURIComponent(jwt)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cmd.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const stdout = String(data.stdout || '');
      const stderr = String(data.stderr || '');
      const statusClass = data.ok ? '#3fb950' : '#ff7b72';
      contentEl.innerHTML = `
        <div class="section-card fade-in">
          <h2>⚡ ${escapeHtml(cmd.label || cmd.id)}</h2>
          <p style="margin-top:4px;color:#8b949e">exit=${data.code} · ${data.durationMs}ms${data.timedOut ? ' · timeout' : ''}</p>
          <div style="margin-top:10px;">
            <div style="font-size:12px;color:${statusClass};margin-bottom:6px;">${data.ok ? 'SUCCESS' : 'FAILED'}</div>
            <pre style="white-space:pre-wrap;word-break:break-word;max-height:45vh;overflow:auto;background:#0d1117;color:#c9d1d9;padding:12px;border-radius:8px;">${escapeHtml(stdout || '(no stdout)')}</pre>
            ${stderr ? `<pre style="white-space:pre-wrap;word-break:break-word;max-height:25vh;overflow:auto;background:#2d1117;color:#ffa198;padding:12px;border-radius:8px;margin-top:10px;">${escapeHtml(stderr)}</pre>` : ''}
          </div>
          <div style="margin-top:12px;display:flex;gap:8px;">
            <button class="button" onclick="window.__canvasActions.openTerminal()">Open Terminal</button>
            <button class="button primary" onclick="window.__canvasActions.refreshStats()">Back Home</button>
          </div>
        </div>
      `;
    } catch (err) {
      showCenter(`Run failed: ${err.message}`, false, 'Back Home', () => showHome());
    }
  }

  function openTerminalAndRun(command) {
    console.log('[Canvas] Opening terminal with command:', command);
    document.getElementById('terminal-pane').style.display = 'flex';
    connectTerminal();
  }

  // ---------- Find in File Functions ----------
  function showFindPanel() {
    const findPanel = document.getElementById('find-panel');
    findPanel.style.display = 'flex';
    document.getElementById('find-input').focus();
    findMatches = [];
    currentMatchIndex = -1;
  }

  function hideFindPanel() {
    document.getElementById('find-panel').style.display = 'none';
    findMatches = [];
    currentMatchIndex = -1;
    if (findInput) {
      findInput.value = '';
      delete findInput.dataset.lastQuery;
    }
  }

  function findInFile() {
    if (!editorInstance) return;
    
    const query = findInput.value;
    if (!query) {
      findStatus.textContent = '';
      return;
    }

    // If same query, go to next match
    if (findMatches.length > 0 && findInput.dataset.lastQuery === query) {
      findNext();
      return;
    }

    const cursor = editorInstance.getSearchCursor(query);
    findMatches = [];
    
    while (cursor.findNext()) {
      findMatches.push({ from: cursor.from(), to: cursor.to() });
    }

    if (findMatches.length === 0) {
      findStatus.textContent = 'No matches';
      return;
    }

    findInput.dataset.lastQuery = query;
    currentMatchIndex = 0;
    editorInstance.setSelection(findMatches[0].from, findMatches[0].to);
    editorInstance.scrollIntoView({ from: findMatches[0].from, to: findMatches[0].to }, 100);
    findStatus.textContent = `1 of ${findMatches.length}`;
  }

  function findNext() {
    if (findMatches.length === 0) return;
    
    currentMatchIndex = (currentMatchIndex + 1) % findMatches.length;
    const match = findMatches[currentMatchIndex];
    editorInstance.setSelection(match.from, match.to);
    editorInstance.scrollIntoView({ from: match.from, to: match.to }, 100);
    findStatus.textContent = `${currentMatchIndex + 1} of ${findMatches.length}`;
  }

  function findPrev() {
    if (findMatches.length === 0) return;
    
    currentMatchIndex = (currentMatchIndex - 1 + findMatches.length) % findMatches.length;
    const match = findMatches[currentMatchIndex];
    editorInstance.setSelection(match.from, match.to);
    editorInstance.scrollIntoView({ from: match.from, to: match.to }, 100);
    findStatus.textContent = `${currentMatchIndex + 1} of ${findMatches.length}`;
  }

  function showFileBrowser() {
    document.getElementById('files-pane').style.display = 'flex';
    loadDirectory(currentPath || '.');
  }

  function closeFileBrowser() {
    document.getElementById('files-pane').style.display = 'none';
    closeEditor();
  }

  // ---------- Home Dashboard ----------
  let recentFiles = [];
  let systemStats = { cpu: 0, memory: 0, disk: 0 };

  async function loadRecentFiles() {
    try {
      const rootPath = normalizeFilePath(fileRootPath || '.');
      const res = await fetch('/fs/tree?path=' + encodeURIComponent(rootPath) + '&token=' + encodeURIComponent(jwt));
      if (!res.ok) return [];
      const data = await res.json();
      const files = (data.items || []).filter(i => i.type === 'file').slice(0, 8);
      
      // Get actual file stats
      const statsPromises = files.map(async f => {
        try {
          const statRes = await fetch('/fs/stat?path=' + encodeURIComponent(f.path) + '&token=' + encodeURIComponent(jwt));
          if (statRes.ok) {
            const stat = await statRes.json();
            return {
              name: f.name,
              path: f.path,
              time: stat.mtime ? new Date(stat.mtime).getTime() : Date.now()
            };
          }
        } catch (e) {}
        return { name: f.name, path: f.path, time: Date.now() };
      });
      
      recentFiles = (await Promise.all(statsPromises))
        .sort((a, b) => b.time - a.time)
        .slice(0, 5);
      return recentFiles;
    } catch (err) {
      return [];
    }
  }

  async function loadSystemStats() {
    try {
      const res = await fetch(`/system/stats?token=${encodeURIComponent(jwt)}`);
      if (res?.ok) {
        const data = await res.json();
        systemStats.cpu = typeof data.cpu === 'number' ? data.cpu : 0;
        systemStats.memory = typeof data.memory === 'number' ? data.memory : 0;
        systemStats.disk = typeof data.disk === 'number' ? data.disk : 0;
      } else {
        systemStats.cpu = 0;
        systemStats.memory = 0;
        systemStats.disk = 0;
      }
    } catch (err) {
      systemStats = { cpu: 0, memory: 0, disk: 0 };
    }
  }

  async function loadQuickCommands() {
    try {
      const res = await fetch('/api/commands?token=' + encodeURIComponent(jwt));
      if (!res.ok) throw new Error('Failed to load commands');
      const data = await res.json();
      quickCommands = data.commands || [];
      console.log('[Canvas] Loaded quick commands:', quickCommands.length);
    } catch (err) {
      console.log('[Canvas] Commands error:', err.message);
      quickCommands = [];
    }
  }

  function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  function getFileIconForName(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
      js: '📜', ts: '📜', py: '🐍', sh: '💻', bash: '💻',
      json: '📋', yaml: '📋', yml: '📋', toml: '📋',
      md: '📝', txt: '📄', log: '📄',
      html: '🌐', css: '🎨', scss: '🎨',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
      mp3: '🎵', mp4: '🎬', wav: '🎵',
      zip: '📦', tar: '📦', gz: '📦',
      pdf: '📕', doc: '📘', docx: '📘',
    };
    return icons[ext] || '📄';
  }

  function getStatClass(value) {
    if (value >= 80) return 'danger';
    if (value >= 60) return 'warning';
    return '';
  }

  // ---------- Commands Editor Functions ----------
  let editingCommandId = null;
  let localCommands = [];

  async function openCommandsEditor() {
    await loadQuickCommands();
    localCommands = [...quickCommands];
    renderCommandsList();
    
    document.getElementById('commands-editor-modal').style.display = 'flex';
  }

  function closeCommandsEditor() {
    document.getElementById('commands-editor-modal').style.display = 'none';
    document.getElementById('command-form-modal').style.display = 'none';
    editingCommandId = null;
  }

  function renderCommandsList() {
    const container = document.getElementById('commands-list');
    
    if (localCommands.length === 0) {
      container.innerHTML = `
        <div class="commands-empty">
          <div class="commands-empty-icon">⚡</div>
          <div class="commands-empty-text">No commands yet. Click "Add Command" to create one!</div>
        </div>
      `;
      return;
    }

    container.innerHTML = localCommands.map((cmd, index) => `
      <div class="command-item" data-index="${index}">
        <div class="command-item-icon">${escapeHtml(cmd.icon || '⚡')}</div>
        <div class="command-item-info">
          <div class="command-item-label">${escapeHtml(cmd.label)}</div>
          <div class="command-item-desc">${escapeHtml(cmd.description || '')}</div>
        </div>
        <span class="command-item-type">${cmd.type}</span>
        <div class="command-item-actions">
          <button class="btn-move" title="Move up" onclick="moveCommand(${index}, -1)">↑</button>
          <button class="btn-move" title="Move down" onclick="moveCommand(${index}, 1)">↓</button>
          <button class="btn-edit" onclick="editCommand(${index})">Edit</button>
          <button class="btn-delete" onclick="deleteCommand(${index})">Delete</button>
        </div>
      </div>
    `).join('');
  }

  function addCommand() {
    editingCommandId = null;
    document.getElementById('commandFormTitle').textContent = 'Add Command';
    document.getElementById('command-form').reset();
    document.getElementById('cmd-id').value = '';
    document.getElementById('cmd-icon').value = '⚡';
    toggleCommandType('navigate');
    openCommandForm();
  }

  function initIconPicker() {
    const picker = document.getElementById('icon-picker');
    const input = document.getElementById('cmd-icon');
    if (!picker || !input) return;
    picker.querySelectorAll('.icon-chip').forEach((btn) => {
      btn.onclick = () => {
        const icon = btn.getAttribute('data-icon-value') || '⚡';
        input.value = icon;
      };
    });
  }

  function editCommand(index) {
    const cmd = localCommands[index];
    editingCommandId = index;
    
    document.getElementById('commandFormTitle').textContent = 'Edit Command';
    document.getElementById('cmd-id').value = cmd.id;
    document.getElementById('cmd-type').value = cmd.type;
    document.getElementById('cmd-label').value = cmd.label;
    document.getElementById('cmd-icon').value = cmd.icon || '⚡';
    document.getElementById('cmd-description').value = cmd.description || '';
    document.getElementById('cmd-path').value = cmd.path || '';
    document.getElementById('cmd-command').value = cmd.command || '';
    
    toggleCommandType(cmd.type);
    openCommandForm();
  }

  function deleteCommand(index) {
    if (confirm('Are you sure you want to delete this command?')) {
      localCommands.splice(index, 1);
      renderCommandsList();
    }
  }

  function moveCommand(index, direction) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= localCommands.length) return;
    
    [localCommands[index], localCommands[newIndex]] = 
    [localCommands[newIndex], localCommands[index]];
    renderCommandsList();
  }

  function toggleCommandType(type) {
    const pathGroup = document.getElementById('path-group');
    const commandGroup = document.getElementById('command-group');
    
    if (type === 'navigate') {
      pathGroup.style.display = 'flex';
      commandGroup.style.display = 'none';
      document.getElementById('cmd-path').required = true;
      document.getElementById('cmd-command').required = false;
    } else {
      pathGroup.style.display = 'none';
      commandGroup.style.display = 'flex';
      document.getElementById('cmd-path').required = false;
      document.getElementById('cmd-command').required = true;
    }
  }

  function openCommandForm() {
    document.getElementById('command-form-modal').style.display = 'flex';
  }

  function closeCommandForm() {
    document.getElementById('command-form-modal').style.display = 'none';
  }

  function saveCommandFromForm(e) {
    e.preventDefault();
    
    const type = document.getElementById('cmd-type').value;
    const label = document.getElementById('cmd-label').value.trim();
    if (!label) {
      alert('Label is required');
      return;
    }
    const cmd = {
      id: document.getElementById('cmd-id').value || `cmd-${Date.now()}`,
      type: type,
      label,
      icon: document.getElementById('cmd-icon').value || '⚡',
      description: document.getElementById('cmd-description').value || '',
    };
    
    if (type === 'navigate') {
      cmd.path = document.getElementById('cmd-path').value;
    } else {
      cmd.command = document.getElementById('cmd-command').value;
    }
    
    if (editingCommandId !== null) {
      localCommands[editingCommandId] = cmd;
    } else {
      localCommands.push(cmd);
    }
    
    closeCommandForm();
    renderCommandsList();
  }

  async function saveCommands() {
    try {
      const res = await fetch('/api/commands?token=' + encodeURIComponent(jwt), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: localCommands }),
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save');
      }
      
      quickCommands = [...localCommands];
      alert('Commands saved successfully!');
      closeCommandsEditor();
      showHome();
    } catch (err) {
      alert('Error saving commands: ' + err.message);
    }
  }

  async function resetCommands() {
    if (confirm('Reset to default commands? This will discard your changes.')) {
      const defaultCommands = [
        { id: 'open-workspace', type: 'navigate', label: 'Workspace', icon: '💼', description: '打开工作区根目录', path: fileRootPath || '.' },
        { id: 'ogs', type: 'exec', label: 'OGS', icon: '🤖', description: '查看 OpenClaw Gateway 状态', command: 'bash "$TG_CANVAS_ROOT/scripts/openclaw-gateway-status.sh" --deep' },
        { id: 'ogr', type: 'exec', label: 'OGR', icon: '🔁', description: '重启 OpenClaw Gateway', command: 'bash "$TG_CANVAS_ROOT/scripts/openclaw-gateway-restart.sh"' },
        { id: 'server-logs', type: 'exec', label: '服务日志', icon: '📋', description: '查看 TG Canvas 服务最近日志', command: 'journalctl -u tg-canvas@main.service -n 50 --no-pager || journalctl -u tg-canvas.service -n 50 --no-pager' },
        { id: 'check-services', type: 'exec', label: '服务状态', icon: '🔧', description: '检查相关服务运行状态', command: 'systemctl --no-pager --type=service --state=running | rg -n "(tg-canvas|ttyd-canvas|cloudflared-canvas)" || true' },
      ];
      localCommands = [...defaultCommands];
      renderCommandsList();
    }
  }

  async function showHome() {
    console.log('[Canvas] showHome called');
    closeFileBrowser();
    closeTerminal();
    
    try {
      await loadRecentFiles();
      await loadSystemStats();
      console.log('[Canvas] showHome: loaded data, recentFiles:', recentFiles.length);

      // Load quick commands
      await loadQuickCommands();
      console.log('[Canvas] showHome: loaded quick commands:', quickCommands.length);

      const quickCommandsHtml = quickCommands.length > 0
        ? `<div class="quick-commands-grid">
            ${quickCommands.map(cmd => `
              <button class="quick-command-btn" data-cmd-id="${cmd.id}" title="${escapeHtml(cmd.description)}">
                <span class="quick-command-icon">${cmd.icon}</span>
                <span class="quick-command-label">${cmd.label}</span>
              </button>
            `).join('')}
          </div>`
        : '';

      const recentFilesHtml = recentFiles.length > 0
        ? recentFiles.map(f => `
            <div class="recent-file-item" data-path="${escapeHtml(f.path)}">
              <span class="recent-file-icon">${getFileIconForName(f.name)}</span>
              <div class="recent-file-info">
                <div class="recent-file-name">${escapeHtml(f.name)}</div>
                <div class="recent-file-time">${formatTimeAgo(f.time)}</div>
              </div>
            </div>
          `).join('')
        : `<div class="empty-state">
             <div class="empty-state-icon">📂</div>
             <div class="empty-state-text">No recent files</div>
           </div>`;

      console.log('[Canvas] showHome: rendering HTML');
      contentEl.innerHTML = `
        <div class="home-dashboard fade-in">
          <div class="welcome-card">
            <h1>👋 OpenClaw Canvas</h1>
            <p>Your AI development workspace</p>
          </div>

          <div class="quick-actions">
            <button class="quick-action-btn" onclick="window.__canvasActions.openFiles()">
              <span class="quick-action-icon">📁</span>
              <span>Files</span>
            </button>
            <button class="quick-action-btn" onclick="window.__canvasActions.openTerminal()">
              <span class="quick-action-icon">💻</span>
              <span>Terminal</span>
            </button>
            <button class="quick-action-btn" onclick="window.__canvasActions.refreshStats()">
              <span class="quick-action-icon">🔄</span>
              <span>Refresh</span>
            </button>
          </div>

          ${quickCommandsHtml ? `
          <div class="section-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <h2 style="margin:0;">⚡ Quick Commands</h2>
              <button onclick="window.__canvasActions.openCommandsEditor()" style="padding:4px 8px;font-size:12px;" class="button">✏️ Edit</button>
            </div>
            ${quickCommandsHtml}
          </div>
          ` : ''}

          <div class="section-card">
            <h2>📄 Recent Files</h2>
            ${recentFilesHtml}
          </div>

          <div class="section-card">
            <h2>🖥️ System Status</h2>
            <div class="stat-row">
              <span class="stat-label">CPU</span>
              <div class="stat-bar">
                <div class="stat-bar-fill ${getStatClass(systemStats.cpu)}" style="width: ${systemStats.cpu}%"></div>
              </div>
              <span class="stat-value">${systemStats.cpu}%</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Memory</span>
              <div class="stat-bar">
                <div class="stat-bar-fill ${getStatClass(systemStats.memory)}" style="width: ${systemStats.memory}%"></div>
              </div>
              <span class="stat-value">${systemStats.memory}%</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Disk</span>
              <div class="stat-bar">
                <div class="stat-bar-fill ${getStatClass(systemStats.disk)}" style="width: ${systemStats.disk}%"></div>
              </div>
              <span class="stat-value">${systemStats.disk}%</span>
            </div>
          </div>
        </div>
      `;
      console.log('[Canvas] showHome: HTML rendered');

      contentEl.querySelectorAll('.recent-file-item').forEach(item => {
        item.onclick = () => {
          const path = item.dataset.path;
          openFile(path);
        };
      });

      // Quick commands handlers
      contentEl.querySelectorAll('.quick-command-btn').forEach(btn => {
        btn.onclick = () => {
          const cmdId = btn.dataset.cmdId;
          const cmd = quickCommands.find(c => c.id === cmdId);
          if (cmd) {
            executeQuickCommand(cmd);
          }
        };
      });
      console.log('[Canvas] showHome: complete');
    } catch (err) {
      console.error('[Canvas] showHome error:', err);
      contentEl.innerHTML = `<div class="center"><div class="empty-state"><div class="empty-state-text">Error: ${err.message}</div></div></div>`;
    }
  }

  function closeTerminal() {
    destroyTerminal();
  }

  // ---------- File Browser Functions ----------
  function setStatus(state) {
    connDot.classList.remove('connected', 'connecting');
    if (state === 'connected') {
      connDot.classList.add('connected');
      connText.textContent = 'Connected';
    } else if (state === 'connecting' || state === 'reconnecting') {
      connDot.classList.add('connecting');
      connText.textContent = state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
    } else {
      connText.textContent = 'Offline';
    }
  }

  function showCenter(message, withSpinner = false, buttonText = null, buttonHandler = null, useCard = true) {
    contentEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'center fade-in';

    let holder = wrap;
    if (useCard) {
      const card = document.createElement('div');
      card.className = 'empty-card';
      wrap.appendChild(card);
      holder = card;
    }

    if (withSpinner) {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      holder.appendChild(spinner);
    }

    const text = document.createElement('div');
    text.textContent = message;
    holder.appendChild(text);

    if (buttonText && buttonHandler) {
      const btn = document.createElement('button');
      btn.className = 'button';
      btn.textContent = buttonText;
      btn.addEventListener('click', buttonHandler);
      holder.appendChild(btn);
    }

    contentEl.appendChild(wrap);
  }

  function formatRelative(ts) {
    if (!ts) return '—';
    const delta = Math.max(0, Date.now() - ts);
    const sec = Math.floor(delta / 1000);
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  }

  function updateLastUpdated(ts) {
    lastUpdatedTs = ts || Date.now();
    lastUpdatedEl.textContent = `Last updated ${formatRelative(lastUpdatedTs)}`;
    clearInterval(relativeTimer);
    relativeTimer = setInterval(() => {
      lastUpdatedEl.textContent = `Last updated ${formatRelative(lastUpdatedTs)}`;
    }, 30000);
  }

  // ---------- Markdown Renderer (minimal) ----------
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderMarkdown(md) {
    // Simple, safe markdown conversion
    const lines = md.split('\n');
    let html = '';
    let inCodeBlock = false;
    let listType = null; // 'ul' | 'ol'

    const closeList = () => {
      if (listType) {
        html += `</${listType}>`;
        listType = null;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Code block (```) toggle
      if (line.trim().startsWith('```')) {
        if (!inCodeBlock) {
          closeList();
          inCodeBlock = true;
          html += '<pre><code>';
        } else {
          inCodeBlock = false;
          html += '</code></pre>';
        }
        continue;
      }

      if (inCodeBlock) {
        html += `${escapeHtml(line)}\n`;
        continue;
      }

      // Headings
      if (/^###\s+/.test(line)) {
        closeList();
        html += `<h3>${escapeHtml(line.replace(/^###\s+/, ''))}</h3>`;
        continue;
      }
      if (/^##\s+/.test(line)) {
        closeList();
        html += `<h2>${escapeHtml(line.replace(/^##\s+/, ''))}</h2>`;
        continue;
      }
      if (/^#\s+/.test(line)) {
        closeList();
        html += `<h1>${escapeHtml(line.replace(/^#\s+/, ''))}</h1>`;
        continue;
      }

      // Lists
      const ulMatch = /^-\s+/.test(line);
      const olMatch = /^\d+\.\s+/.test(line);
      if (ulMatch || olMatch) {
        const type = ulMatch ? 'ul' : 'ol';
        if (listType && listType !== type) closeList();
        if (!listType) {
          listType = type;
          html += `<${listType}>`;
        }
        const itemText = line.replace(ulMatch ? /^-\s+/ : /^\d+\.\s+/, '');
        html += `<li>${inlineMarkdown(escapeHtml(itemText))}</li>`;
        continue;
      } else {
        closeList();
      }

      // Paragraphs / blank
      if (line.trim() === '') {
        html += '<br />';
      } else {
        html += `<p>${inlineMarkdown(escapeHtml(line))}</p>`;
      }
    }

    closeList();
    return html;
  }

  function inlineMarkdown(text) {
    // bold **text**
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // italic *text*
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // inline code `code`
    text = text.replace(/`(.+?)`/g, '<code>$1</code>');
    return text;
  }

  // ---------- Rendering ----------
  function renderA2UI(container, a2uiPayload) {
    // Optional A2UI runtime hook. If present, use it. Otherwise show JSON.
    const runtime = window.OpenClawA2UI || window.A2UI || null;
    if (runtime && typeof runtime.render === 'function') {
      try {
        runtime.render(container, a2uiPayload);
        return;
      } catch (_) {
        // fall through to JSON
      }
    }
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(a2uiPayload, null, 2);
    container.appendChild(pre);
  }

  // ---------- Terminal ----------
  let termIframe = null;

  function destroyTerminal() {
    const pane = document.getElementById('terminal-pane');
    pane.style.display = 'none';
    if (termIframe) {
      try { termIframe.remove(); } catch (_) {}
      termIframe = null;
    }
    document.getElementById('terminal-container').innerHTML = '';
  }

  function connectTerminal() {
    const containerEl = document.getElementById('terminal-container');
    containerEl.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.className = 'terminal-iframe';
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
    iframe.src = `/ttyd/?token=${encodeURIComponent(jwt)}`;
    termIframe = iframe;
    containerEl.appendChild(iframe);
  }

  // ---------- Rendering ----------
  function renderPayload(payload) {
    if (!payload || payload.type === 'clear') {
      destroyTerminal();
      showHome();
      return;
    }

    const { format, content } = payload;
    contentEl.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'fade-in';

    if (format === 'html') {
      // Trusted HTML from server (agent only)
      container.innerHTML = content || '';
      // Execute inline scripts (Telegram WebView doesn't run scripts from innerHTML)
      container.querySelectorAll('script').forEach((oldScript) => {
        const s = document.createElement('script');
        if (oldScript.src) s.src = oldScript.src;
        s.type = oldScript.type || 'text/javascript';
        s.text = oldScript.textContent || '';
        oldScript.replaceWith(s);
      });
    } else if (format === 'markdown') {
      container.innerHTML = renderMarkdown(content || '');
    } else if (format === 'a2ui') {
      renderA2UI(container, content || {});
    } else {
      // text
      const pre = document.createElement('pre');
      pre.textContent = content || '';
      container.appendChild(pre);
    }

    contentEl.appendChild(container);
    updateLastUpdated(Date.now());
  }

  // ---------- Auth + Networking ----------
  async function authenticate() {
    const initData = tg?.initData || '';
    
    // Debug log
    console.log('[Canvas] Telegram WebApp:', !!tg);
    console.log('[Canvas] initData present:', !!initData);
    console.log('[Canvas] initData length:', initData?.length || 0);
    
    try {
      const res = await fetch('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });

      const data = await res.json();
      console.log('[Canvas] Auth response:', res.status, data);

      if (!res.ok) throw new Error(data.error || 'auth_failed');
      if (!data?.token) throw new Error('no_token');
      jwt = data.token;
      console.log('[Canvas] Auth successful, user:', data.user);

      if (openTerminalBtn) {
        openTerminalBtn.onclick = () => {
          document.getElementById('terminal-pane').style.display = 'flex';
          connectTerminal();
        };
      }

      if (closeTerminalBtn) {
        closeTerminalBtn.onclick = () => {
          destroyTerminal();
        };
      }

      // File browser buttons
      if (openFilesBtn) {
        openFilesBtn.onclick = showFileBrowser;
      }
      if (closeFilesBtn) {
        closeFilesBtn.onclick = closeFileBrowser;
      }
      if (editorBackBtn) {
        editorBackBtn.onclick = closeEditor;
      }
      if (editorSaveBtn) {
        editorSaveBtn.onclick = saveFile;
      }
      if (editorSearchBtn) {
        editorSearchBtn.onclick = showFindPanel;
      }

      // Find panel handlers
      if (findCloseBtn) {
        findCloseBtn.onclick = hideFindPanel;
      }
      if (findNextBtn) {
        findNextBtn.onclick = findNext;
      }
      if (findPrevBtn) {
        findPrevBtn.onclick = findPrev;
      }
      if (findInput) {
        findInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') findInFile();
        });
      }

      // Home button
      if (openHomeBtn) {
        openHomeBtn.onclick = showHome;
      }

      // Search functionality
      if (searchBtn) {
        searchBtn.onclick = performSearch;
      }
      if (clearSearchBtn) {
        clearSearchBtn.onclick = clearSearch;
      }
      if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') performSearch();
        });
      }

      // Commands editor handlers
      const closeCommandsEditorBtn = document.getElementById('closeCommandsEditorBtn');
      if (closeCommandsEditorBtn) {
        closeCommandsEditorBtn.onclick = closeCommandsEditor;
      }
      const addCommandBtn = document.getElementById('addCommandBtn');
      if (addCommandBtn) {
        addCommandBtn.onclick = addCommand;
      }
      const saveCommandsBtn = document.getElementById('saveCommandsBtn');
      if (saveCommandsBtn) {
        saveCommandsBtn.onclick = saveCommands;
      }
      const resetCommandsBtn = document.getElementById('resetCommandsBtn');
      if (resetCommandsBtn) {
        resetCommandsBtn.onclick = resetCommands;
      }
      const closeCommandFormBtn = document.getElementById('closeCommandFormBtn');
      if (closeCommandFormBtn) {
        closeCommandFormBtn.onclick = closeCommandForm;
      }
      const cancelCommandBtn = document.getElementById('cancelCommandBtn');
      if (cancelCommandBtn) {
        cancelCommandBtn.onclick = closeCommandForm;
      }
      const commandForm = document.getElementById('command-form');
      if (commandForm) {
        commandForm.onsubmit = saveCommandFromForm;
      }
      const cmdTypeSelect = document.getElementById('cmd-type');
      if (cmdTypeSelect) {
        cmdTypeSelect.onchange = (e) => toggleCommandType(e.target.value);
      }

      // Expose moveCommand, editCommand, deleteCommand to global scope for inline onclick
      window.moveCommand = moveCommand;
      window.editCommand = editCommand;
      window.deleteCommand = deleteCommand;

  // Global actions for dashboard buttons
  window.__canvasActions = {
    openFiles: showFileBrowser,
    openTerminal: () => {
      document.getElementById('terminal-pane').style.display = 'flex';
      connectTerminal();
    },
    refreshStats: showHome,
    openCommandsEditor: openCommandsEditor,
  };

      return true;
    } catch (e) {
      return false;
    }
  }

  async function fetchState() {
    try {
      const res = await fetch(`/state?token=${encodeURIComponent(jwt)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  function connectWS() {
    if (!jwt) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws?token=${encodeURIComponent(jwt)}`;

    setStatus('connecting');
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ping') return;
        if (msg.type === 'clear') {
          renderPayload({ type: 'clear' });
          return;
        }
        if (msg.type === 'canvas') {
          renderPayload(msg);
        }
      } catch (e) {
        // ignore malformed message
      }
    };

    ws.onerror = () => {
      setStatus('reconnecting');
      showCenter('Connection lost. Reconnecting…', true);
    };

    ws.onclose = () => {
      setStatus('reconnecting');
      showCenter('Connection lost. Reconnecting…', true);
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connectWS();
    }, 3000);
  }

  // ---------- Boot ----------
  async function boot() {
    console.log('[Canvas] boot started');
    // Initialize DOM elements
    initDOMElements();
    initIconPicker();

    // Wait for DOM to be ready
    if (!contentEl) {
      console.error('[Canvas] contentEl not found, waiting...');
      await new Promise(resolve => setTimeout(resolve, 500));
      initDOMElements();
      initIconPicker();
    }

    setStatus('connecting');
    showCenter('Connecting…', true, null, null, false);

    const authed = await authenticate();
    console.log('[Canvas] boot: authed =', authed);
    if (!authed) {
      setStatus('disconnected');
      showCenter('Access denied', false, 'Close', () => tg?.close?.());
      return;
    }

    // Fetch current state before WS connect
    console.log('[Canvas] boot: fetching state...');
    const state = await fetchState();
    console.log('[Canvas] boot: state =', state);
    if (state && state.content) {
      console.log('[Canvas] boot: rendering payload');
      renderPayload(state);
    } else {
      console.log('[Canvas] boot: showing home');
      showHome();
    }

    connectWS();
  }

  boot();
})();
