document.addEventListener('DOMContentLoaded', () => {
    // Dynamic import for auto-repair script
    let jsonrepair = null;
    import('https://cdn.jsdelivr.net/npm/jsonrepair@3/lib/esm/index.js')
        .then(mod => { jsonrepair = mod.jsonrepair; })
        .catch(err => console.error("Auto-fix library failed to load:", err));

    // Escape HTML to prevent XSS in Tree View
    function escapeHTML(str) {
        if (typeof str !== 'string') return str;
        return str.replace(/[&<>'"]/g, tag => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[tag] || tag));
    }

    // Initialize Ace Editors
    ace.config.set('basePath', 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.2/');
    
    const inputEditor = ace.edit("input-editor");
    inputEditor.setTheme("ace/theme/tomorrow_night_eighties");
    inputEditor.session.setMode("ace/mode/json");
    inputEditor.setOptions({
        fontSize: "14px",
        fontFamily: "'Fira Code', monospace",
        showPrintMargin: false,
        wrap: true,
        useWorker: true
    });

    const outputEditor = ace.edit("output-editor");
    outputEditor.setTheme("ace/theme/tomorrow_night_eighties");
    outputEditor.session.setMode("ace/mode/json");
    outputEditor.setOptions({
        fontSize: "14px",
        fontFamily: "'Fira Code', monospace",
        showPrintMargin: false,
        wrap: true,
        readOnly: true,
        useWorker: false
    });

    // Elements
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = statusIndicator.querySelector('.status-text');
    const errorMsgEl = document.getElementById('error-message');
    const btnJumpError = document.getElementById('btn-jump-error');
    const inputSize = document.getElementById('input-size');
    const outputSize = document.getElementById('output-size');
    const treeView = document.getElementById('tree-view');
    const outputEditorEl = document.getElementById('output-editor');
    const autoFormatToggle = document.getElementById('auto-format-toggle');
    
    let isAutoFormat = autoFormatToggle.checked;
    let currentRawData = null;
    let currentError = null;

    // Formatting sizes
    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const dp = 1;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dp)) + ' ' + sizes[i];
    }

    function updateSizes() {
        const inVal = inputEditor.getValue();
        const outVal = outputEditor.getValue();
        inputSize.textContent = formatBytes(new Blob([inVal]).size);
        outputSize.textContent = formatBytes(new Blob([outVal]).size);
    }

    // Basic Error Position Extraction
    function extractErrorDetails(errorString, text) {
        const match = errorString.match(/at position (\d+)/);
        if (match && match[1]) {
            const pos = parseInt(match[1], 10);
            const textBefore = text.slice(0, pos);
            const lines = textBefore.split('\n');
            const line = lines.length;
            
            const contextStart = Math.max(0, pos - 10);
            const context = text.slice(contextStart, pos + 5);
            
            let hint = "";
            if (context.includes(',}') || context.includes(',]')) hint = "Possible trailing comma.";
            if (errorString.includes('Expected double-quoted property name')) hint = "Keys must be in double quotes (e.g. \"key\": value).";
            
            return { line, pos, hint, message: errorString };
        }
        
        const lineMatch = errorString.match(/line (\d+) column (\d+)/);
        if (lineMatch) {
            return { line: parseInt(lineMatch[1]), message: errorString, hint: "" };
        }
        
        return { line: 1, message: errorString, hint: "" };
    }

    // Set Status Badge UI
    function setStatus(isValid, text, errDetails = null) {
        statusIndicator.className = isValid ? 'status-badge status-valid' : 'status-badge status-invalid';
        statusText.textContent = text;
        
        const Range = ace.require('ace/range').Range;
        const session = inputEditor.getSession();
        
        // Remove old markers
        for (const id in session.$backMarkers) {
            if (session.$backMarkers[id].clazz === "error-marker") {
                session.removeMarker(id);
            }
        }

        if (isValid) {
            // Reset state
            if (text === "Auto-Corrected") {
                // If auto-corrected, we keep the message around but using a warning color
                statusIndicator.className = 'status-badge status-valid'; // Actually maybe a different color for Warn
                statusText.textContent = text;
                btnJumpError.classList.add('hidden');
            } else {
                errorMsgEl.textContent = "";
                btnJumpError.classList.add('hidden');
                currentError = null;
                errorMsgEl.style.color = "var(--danger)";
            }
        } else {
            let msg = errDetails.message;
            if (errDetails.hint) msg += ` (${errDetails.hint})`;
            errorMsgEl.textContent = `Error Line ${errDetails.line}: ${msg}`;
            errorMsgEl.style.color = "var(--danger)";
            btnJumpError.classList.remove('hidden');
            currentError = errDetails;

            session.addMarker(new Range(errDetails.line - 1, 0, errDetails.line - 1, 1), "error-marker", "fullLine");
        }
    }

    btnJumpError.addEventListener('click', () => {
        if (currentError) {
            inputEditor.gotoLine(currentError.line, 0, true);
            inputEditor.focus();
        }
    });

    // Validation & Processing
    function validateAndProcess() {
        const text = inputEditor.getValue();
        updateSizes();
        
        if (!text.trim()) {
            setStatus(true, "Ready");
            outputEditor.setValue("");
            currentRawData = null;
            renderTree(null);
            return;
        }

        try {
            const data = JSON.parse(text);
            setStatus(true, "Valid JSON");
            currentRawData = data;
            
            if (isAutoFormat) {
                const formatted = JSON.stringify(data, null, 2);
                if (outputEditor.getValue() !== formatted) {
                    outputEditor.setValue(formatted, -1);
                }
            }
            
            if (!treeView.classList.contains('hidden')) {
                renderTree(data);
            }
            updateSizes();
        } catch (e) {
            currentRawData = null;
            const errDetails = extractErrorDetails(e.message, text);
            
            // Try to auto-correct
            if (jsonrepair) {
                let repairedData = null;
                try {
                    const repairedText = jsonrepair(text);
                    repairedData = JSON.parse(repairedText);
                } catch (repairErr) {
                    // Optional aggressive pre-processing fallback
                    try {
                        let fixed = text
                            .replace(/\btru\b/g, 'true')
                            .replace(/\byes\b/g, '"yes"')
                            .replace(/\bundefined\b/g, 'null')
                            .replace(/\bNaN\b/g, '"NaN"')
                            .replace(/\bInfinity\b/g, '"Infinity"')
                            .replace(/,\s*,/g, ',');
                        if (fixed.trim().endsWith('.')) {
                            fixed = fixed.trim().slice(0, -1);
                        }
                        const repairedText = jsonrepair(fixed);
                        repairedData = JSON.parse(repairedText);
                    } catch (e2) {}
                }

                if (repairedData) {
                    setStatus(true, "Auto-Corrected", errDetails);
                    currentRawData = repairedData;
                    
                    errorMsgEl.textContent = `Auto-fixed JSON! Found issues around Line ${errDetails.line} (${errDetails.message})`;
                    errorMsgEl.style.color = "var(--warn)";
                    
                    if (isAutoFormat) {
                        const formatted = JSON.stringify(repairedData, null, 2);
                        if (outputEditor.getValue() !== formatted) {
                            outputEditor.setValue(formatted, -1);
                        }
                    }
                    if (!treeView.classList.contains('hidden')) {
                        renderTree(repairedData);
                    }
                    updateSizes();
                    return;
                }
            }

            setStatus(false, "Invalid JSON", errDetails);
        }
    }

    let debounceTimer;
    inputEditor.session.on('change', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(validateAndProcess, 400);
    });

    // Toolbar Actions
    document.getElementById('btn-format').addEventListener('click', () => {
        const text = inputEditor.getValue();
        if(!text.trim()) return;
        try {
            const data = JSON.parse(text);
            const formatted = JSON.stringify(data, null, 2);
            outputEditor.setValue(formatted, -1);
            if (!treeView.classList.contains('hidden')) renderTree(data);
            updateSizes();
        } catch(e) {
            if (jsonrepair) {
                try {
                    let repairedText = "";
                    try { repairedText = jsonrepair(text); }
                    catch(e1) {
                         let fixed = text.replace(/\btru\b/g, 'true').replace(/\byes\b/g, '"yes"').replace(/\bundefined\b/g, 'null').replace(/\bNaN\b/g, '"NaN"').replace(/\bInfinity\b/g, '"Infinity"').replace(/,\s*,/g, ',');
                         if (fixed.trim().endsWith('.')) fixed = fixed.trim().slice(0, -1);
                         repairedText = jsonrepair(fixed);
                    }
                    const repairedData = JSON.parse(repairedText);
                    const formatted = JSON.stringify(repairedData, null, 2);
                    outputEditor.setValue(formatted, -1);
                    if (!treeView.classList.contains('hidden')) renderTree(repairedData);
                    updateSizes();
                    return;
                } catch(e2) {}
            }
            alert("Cannot format: fix JSON errors first.");
        }
    });

    document.getElementById('btn-minify').addEventListener('click', () => {
        const text = inputEditor.getValue();
        if(!text.trim()) return;
        try {
            const data = JSON.parse(text);
            const minified = JSON.stringify(data);
            outputEditor.setValue(minified, -1);
            if (!treeView.classList.contains('hidden')) renderTree(data);
            updateSizes();
        } catch(e) {
            if (jsonrepair) {
                try {
                    let repairedText = "";
                    try { repairedText = jsonrepair(text); }
                    catch(e1) {
                         let fixed = text.replace(/\btru\b/g, 'true').replace(/\byes\b/g, '"yes"').replace(/\bundefined\b/g, 'null').replace(/\bNaN\b/g, '"NaN"').replace(/\bInfinity\b/g, '"Infinity"').replace(/,\s*,/g, ',');
                         if (fixed.trim().endsWith('.')) fixed = fixed.trim().slice(0, -1);
                         repairedText = jsonrepair(fixed);
                    }
                    const repairedData = JSON.parse(repairedText);
                    const minified = JSON.stringify(repairedData);
                    outputEditor.setValue(minified, -1);
                    if (!treeView.classList.contains('hidden')) renderTree(repairedData);
                    updateSizes();
                    return;
                } catch(e2) {}
            }
            alert("Cannot minify: fix JSON errors first.");
        }
    });

    autoFormatToggle.addEventListener('change', (e) => {
        isAutoFormat = e.target.checked;
        if(isAutoFormat) validateAndProcess();
    });

    // Upload & Download
    document.getElementById('file-upload').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            inputEditor.setValue(ev.target.result, -1);
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    document.getElementById('btn-download').addEventListener('click', () => {
        const text = outputEditor.getValue() || inputEditor.getValue();
        if(!text) return;
        const blob = new Blob([text], {type: "application/json"});
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "data.json";
        link.click();
    });

    document.getElementById('btn-copy').addEventListener('click', () => {
        const text = outputEditor.getValue();
        if(!text) return;
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('btn-copy');
            const origHTML = btn.innerHTML;
            btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><path d="M20 6L9 17l-5-5"></path></svg> Copied!`;
            setTimeout(() => btn.innerHTML = origHTML, 2000);
        });
    });

    // View Toggles
    const btnRaw = document.getElementById('btn-view-raw');
    const btnTree = document.getElementById('btn-view-tree');
    
    btnRaw.addEventListener('click', () => {
        btnRaw.classList.add('active');
        btnTree.classList.remove('active');
        outputEditorEl.classList.remove('hidden');
        treeView.classList.add('hidden');
    });

    btnTree.addEventListener('click', () => {
        btnTree.classList.add('active');
        btnRaw.classList.remove('active');
        treeView.classList.remove('hidden');
        outputEditorEl.classList.add('hidden');
        if (currentRawData !== null) renderTree(currentRawData);
    });

    // Tree View Rendering
    function createTreeNode(key, value, isLast) {
        const el = document.createElement('div');
        el.className = 'tree-node tree-expanded';
        
        const type = value === null ? 'null' : typeof value;
        const isObject = value !== null && type === 'object';
        
        let html = '';
        if (isObject) {
            html += `<span class="tree-toggle"></span>`;
        }
        
        if (key !== null) {
            html += `<span class="tree-key">"${escapeHTML(String(key))}"</span>: `;
        }

        if (isObject) {
            const isArray = Array.isArray(value);
            const openBracket = isArray ? '[' : '{';
            const closeBracket = isArray ? ']' : '}';
            const keys = Object.keys(value);
            
            if (keys.length === 0) {
                html += `${openBracket}${closeBracket}${isLast ? '' : ','}`;
                el.innerHTML = html;
            } else {
                html += `${openBracket}`;
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'tree-children';
                
                keys.forEach((k, idx) => {
                    const isLastChild = idx === keys.length - 1;
                    childrenContainer.appendChild(createTreeNode(isArray ? null : k, value[k], isLastChild));
                });
                
                el.innerHTML = html;
                el.appendChild(childrenContainer);
                el.insertAdjacentHTML('beforeend', `<div>${closeBracket}${isLast ? '' : ','}</div>`);
                
                el.querySelector('.tree-toggle').addEventListener('click', function(e) {
                    e.stopPropagation();
                    const parent = this.parentElement;
                    if(parent.classList.contains('tree-expanded')) {
                        parent.classList.remove('tree-expanded');
                        parent.classList.add('tree-collapsed');
                    } else {
                        parent.classList.remove('tree-collapsed');
                        parent.classList.add('tree-expanded');
                    }
                });
            }
        } else {
            let valStr = value;
            if (type === 'string') valStr = `"${escapeHTML(value)}"`;
            html += `<span class="tree-${type}">${valStr}</span>${isLast ? '' : ','}`;
            el.innerHTML = html;
        }
        return el;
    }

    function renderTree(data) {
        treeView.innerHTML = '';
        if (data === null) return;
        treeView.appendChild(createTreeNode(null, data, true));
    }

    // Theme Setup
    const themeToggle = document.getElementById('theme-toggle');
    const htmlEl = document.documentElement;
    
    // Auto detect OS theme
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
       htmlEl.setAttribute('data-theme', 'light');
       updateEditorTheme('light');
    }

    themeToggle.addEventListener('click', () => {
        const current = htmlEl.getAttribute('data-theme') || 'dark';
        const nextTheme = current === 'dark' ? 'light' : 'dark';
        htmlEl.setAttribute('data-theme', nextTheme);
        updateEditorTheme(nextTheme);
    });

    function updateEditorTheme(theme) {
        if(theme === 'light') {
            inputEditor.setTheme("ace/theme/chrome");
            outputEditor.setTheme("ace/theme/chrome");
        } else {
            inputEditor.setTheme("ace/theme/tomorrow_night_eighties");
            outputEditor.setTheme("ace/theme/tomorrow_night_eighties");
        }
    }

    // Resizable Split Pane configuration
    const divider = document.querySelector('.divider');
    const container = document.querySelector('.editor-container');
    const leftPane = document.querySelector('.left-pane');
    
    let isDragging = false;
    
    divider.addEventListener('mousedown', (e) => {
        isDragging = true;
        divider.classList.add('active');
        document.body.style.cursor = 'col-resize';
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const containerRect = container.getBoundingClientRect();
        // Calculate new width percent to keep it fully responsive
        let newWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;
        // Clamp bounds
        if (newWidth < 10) newWidth = 10;
        if (newWidth > 90) newWidth = 90;
        leftPane.style.flex = `0 0 ${newWidth}%`;
        inputEditor.resize();
        outputEditor.resize();
    });
    
    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            divider.classList.remove('active');
            document.body.style.cursor = 'default';
        }
    });

    // Sample Data trigger on empty click (optional nice feature to test)
    // inputEditor.setValue("{\n  \"hello\": \"world\"\n}", -1);
});
