// WYSIWYG editor for gemtext.
//
// Gemtext (https://geminiprotocol.net/docs/gemtext-specification.gmi) is
// strictly line-oriented and has only six line shapes:
//
//   #, ##, ###  -> headings (level 1-3)
//   =>          -> link
//   *           -> list item
//   >           -> blockquote
//   ```         -> toggle preformatted block
//   anything    -> paragraph
//
// Inside a preformatted block every line is verbatim until the next
// closing ``` toggle. There is no inline markup.
//
// This editor maps each line shape to a single DOM block in a
// contenteditable host. Saving serializes the DOM back to gemtext;
// loading parses gemtext into the DOM. The mapping is one-to-one so
// edits are non-destructive: re-loading what you just saved gives the
// same DOM you started with.

const Lines = {
    H1: "h1",
    H2: "h2",
    H3: "h3",
    LINK: "link",
    LIST: "list-item",
    QUOTE: "quote",
    PRE: "pre",
    P: "p",
};

const SHAPE_LABEL = {
    [Lines.P]: "Paragraph",
    [Lines.H1]: "Heading 1",
    [Lines.H2]: "Heading 2",
    [Lines.H3]: "Heading 3",
    [Lines.LIST]: "List item",
    [Lines.QUOTE]: "Quote",
    [Lines.LINK]: "Link",
    [Lines.PRE]: "Preformatted",
};

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k === "text") node.textContent = v;
        else node.setAttribute(k, v);
    }
    for (const child of children) {
        if (child == null) continue;
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
}

// ---------------------------------------------------------------- parser

// Parse a gemtext source string into an array of {shape, ...} records.
// Preformatted blocks are emitted as a single {shape: PRE, alt, body}
// record; everything else is one record per source line.
export function parseGemtext(src) {
    const out = [];
    const lines = src.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith("```")) {
            const alt = line.slice(3);
            const body = [];
            i++;
            while (i < lines.length && !lines[i].startsWith("```")) {
                body.push(lines[i]);
                i++;
            }
            // Skip the closing ``` if present (a missing closer is
            // tolerated -- the rest of the file is treated as
            // preformatted, matching agate's behaviour).
            if (i < lines.length) i++;
            out.push({shape: Lines.PRE, alt, body: body.join("\n")});
            continue;
        }
        if (line.startsWith("###")) {
            out.push({shape: Lines.H3, text: line.slice(3).trimStart()});
        } else if (line.startsWith("##")) {
            out.push({shape: Lines.H2, text: line.slice(2).trimStart()});
        } else if (line.startsWith("#")) {
            out.push({shape: Lines.H1, text: line.slice(1).trimStart()});
        } else if (line.startsWith("=>")) {
            // `=> URL [whitespace LABEL]`. The spec is permissive about
            // the whitespace; we split on the first run of spaces/tabs
            // after the URL token.
            const rest = line.slice(2).trimStart();
            const m = rest.match(/^(\S+)\s*(.*)$/);
            if (m) {
                out.push({shape: Lines.LINK, url: m[1], label: m[2]});
            } else {
                out.push({shape: Lines.LINK, url: "", label: ""});
            }
        } else if (line.startsWith("* ")) {
            out.push({shape: Lines.LIST, text: line.slice(2)});
        } else if (line === "*") {
            out.push({shape: Lines.LIST, text: ""});
        } else if (line.startsWith(">")) {
            // Spec allows `> text` or `>text`; trim a single leading
            // space if present.
            let t = line.slice(1);
            if (t.startsWith(" ")) t = t.slice(1);
            out.push({shape: Lines.QUOTE, text: t});
        } else {
            out.push({shape: Lines.P, text: line});
        }
        i++;
    }
    // Strip a single trailing empty paragraph that the split() on a
    // file ending in \n produces, so a save-then-reload round-trip is
    // stable.
    if (out.length > 0) {
        const last = out[out.length - 1];
        if (last.shape === Lines.P && last.text === "") out.pop();
    }
    return out;
}

// -------------------------------------------------------------- serializer

// Serialize an array of records back to gemtext. The exact inverse of
// parseGemtext for the line shapes it produces.
export function serializeGemtext(records) {
    const lines = [];
    for (const r of records) {
        switch (r.shape) {
            case Lines.H1: lines.push("# " + r.text); break;
            case Lines.H2: lines.push("## " + r.text); break;
            case Lines.H3: lines.push("### " + r.text); break;
            case Lines.LINK: {
                const label = (r.label || "").trim();
                if (label) lines.push("=> " + r.url + " " + label);
                else lines.push("=> " + r.url);
                break;
            }
            case Lines.LIST: lines.push("* " + r.text); break;
            case Lines.QUOTE: lines.push("> " + r.text); break;
            case Lines.PRE:
                lines.push("```" + (r.alt || ""));
                if (r.body) lines.push(...r.body.split("\n"));
                lines.push("```");
                break;
            case Lines.P:
            default:
                lines.push(r.text);
                break;
        }
    }
    return lines.join("\n") + "\n";
}

// --------------------------------------------------------------- DOM <-> records

// Render an array of records into the editor's contenteditable host.
// Each record becomes one block element with data-shape= so we can
// serialize back without inferring shape from tag alone (multiple
// shapes share tags, e.g. a `> quote` is a `<div>` to keep CSS clean).
function recordsToDOM(host, records) {
    while (host.firstChild) host.removeChild(host.firstChild);
    if (records.length === 0) {
        host.appendChild(blockFor({shape: Lines.P, text: ""}));
        return;
    }
    for (const r of records) host.appendChild(blockFor(r));
}

function blockFor(r) {
    switch (r.shape) {
        case Lines.H1: return el("h1", {class: "gem-block", dataset: {shape: r.shape}, text: r.text});
        case Lines.H2: return el("h2", {class: "gem-block", dataset: {shape: r.shape}, text: r.text});
        case Lines.H3: return el("h3", {class: "gem-block", dataset: {shape: r.shape}, text: r.text});
        case Lines.LIST: {
            const li = el("div", {class: "gem-block gem-li", dataset: {shape: r.shape}}, [
                el("span", {class: "gem-bullet", text: "\u2022"}),
                el("span", {class: "gem-text", text: r.text}),
            ]);
            return li;
        }
        case Lines.QUOTE: return el("blockquote", {class: "gem-block", dataset: {shape: r.shape}, text: r.text});
        case Lines.LINK: {
            return el("div", {class: "gem-block gem-link", dataset: {shape: r.shape}}, [
                el("span", {class: "gem-link-arrow", text: "\u2192"}),
                el("span", {class: "gem-link-url", text: r.url, "contenteditable": "true",
                            "data-placeholder": "gemini://...", "spellcheck": "false"}),
                el("span", {class: "gem-link-sep", text: " \u00b7 "}),
                el("span", {class: "gem-link-label", text: r.label, "contenteditable": "true",
                            "data-placeholder": "label (optional)"}),
            ]);
        }
        case Lines.PRE: {
            return el("pre", {class: "gem-block", dataset: {shape: r.shape, alt: r.alt || ""}, text: r.body});
        }
        case Lines.P:
        default:
            return el("p", {class: "gem-block", dataset: {shape: Lines.P}, text: r.text});
    }
}

// Walk the editor host and rebuild a record array. The shape comes
// from data-shape; the text comes from textContent (or the per-field
// spans for the link block).
function domToRecords(host) {
    const out = [];
    for (const node of host.children) {
        const shape = node.dataset.shape;
        if (!shape) continue;
        switch (shape) {
            case Lines.LINK: {
                const url = (node.querySelector(".gem-link-url")?.textContent || "").trim();
                const label = (node.querySelector(".gem-link-label")?.textContent || "").trim();
                out.push({shape, url, label});
                break;
            }
            case Lines.LIST: {
                const text = node.querySelector(".gem-text")?.textContent || "";
                out.push({shape, text});
                break;
            }
            case Lines.PRE: {
                out.push({shape, alt: node.dataset.alt || "", body: node.textContent || ""});
                break;
            }
            default:
                out.push({shape, text: node.textContent || ""});
        }
    }
    return out;
}

// -------------------------------------------------------------- editor host

class Editor {
    constructor(host, statusEl) {
        this.host = host;
        this.statusEl = statusEl;
        this.host.addEventListener("keydown", (e) => this.onKeydown(e));
        this.host.addEventListener("input", () => this.markDirty());
        this.dirty = false;
        this.path = null;
    }

    setStatus(text, klass = "") {
        this.statusEl.textContent = text;
        this.statusEl.className = "editor-status " + klass;
    }

    markDirty() {
        if (!this.dirty) {
            this.dirty = true;
            this.setStatus("Unsaved changes", "warn");
        }
    }

    markSaved() {
        this.dirty = false;
        this.setStatus("Saved", "ok");
    }

    load(path, src) {
        this.path = path;
        const records = parseGemtext(src);
        recordsToDOM(this.host, records);
        this.dirty = false;
        this.setStatus("Loaded " + path);
    }

    serialize() {
        return serializeGemtext(domToRecords(this.host));
    }

    // Determine which block contains the current selection so menu
    // commands ("change to heading 1", etc.) know what to act on.
    currentBlock() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        let node = sel.getRangeAt(0).startContainer;
        while (node && node.parentElement !== this.host) node = node.parentNode;
        return node && node.parentElement === this.host ? node : null;
    }

    setShape(shape) {
        const block = this.currentBlock();
        if (!block) return;
        // Pull the current text out, then replace the block in place
        // with one of the new shape carrying the same text.
        let text = "";
        const oldShape = block.dataset.shape;
        if (oldShape === Lines.LINK) {
            text = (block.querySelector(".gem-link-label")?.textContent || "").trim();
        } else if (oldShape === Lines.LIST) {
            text = block.querySelector(".gem-text")?.textContent || "";
        } else if (oldShape === Lines.PRE) {
            text = block.textContent || "";
        } else {
            text = block.textContent || "";
        }
        let r;
        if (shape === Lines.LINK) {
            r = {shape, url: "", label: text};
        } else if (shape === Lines.PRE) {
            r = {shape, alt: "", body: text};
        } else {
            r = {shape, text};
        }
        const newBlock = blockFor(r);
        block.replaceWith(newBlock);
        // Place the cursor inside the new block at the end.
        const range = document.createRange();
        range.selectNodeContents(newBlock);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        this.markDirty();
    }

    // Make Enter behave: in most blocks Enter splits to a new
    // paragraph (returning to plain shape after a heading). In a list
    // item Enter creates another list item; on an empty list item it
    // demotes to a paragraph (the same convention rich editors use).
    // In a preformatted block Enter inserts a real newline.
    onKeydown(e) {
        if (e.key !== "Enter") return;
        const block = this.currentBlock();
        if (!block) return;
        const shape = block.dataset.shape;
        if (shape === Lines.PRE) return; // default behaviour: insert \n
        if (e.shiftKey) return; // Shift+Enter -> default <br>; useful inside a paragraph
        e.preventDefault();
        let nextShape = Lines.P;
        if (shape === Lines.LIST) {
            const text = block.querySelector(".gem-text")?.textContent || "";
            if (text === "") {
                // Empty list item: demote to paragraph in place.
                this.setShape(Lines.P);
                return;
            }
            nextShape = Lines.LIST;
        }
        const newBlock = blockFor({shape: nextShape, text: ""});
        block.after(newBlock);
        const range = document.createRange();
        range.selectNodeContents(newBlock);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        this.markDirty();
    }
}

// ----------------------------------------------------------------- API client

// Encode a path while preserving "/" separators. encodeURIComponent
// alone would escape slashes (% 2F), and Starlette's `{rel:path}`
// converter would receive the percent-encoded form -- which fails
// our `_VALID_RELPATH_RE` validation and 400s every subdirectory
// file. Encode each segment individually instead.
function encodePath(p) {
    return p.split("/").map(encodeURIComponent).join("/");
}

// All API helpers go through this single fetch wrapper so credentials
// handling, error formatting, and JSON parsing live in one place.
// `parse` controls what we read off the response: "json" for normal
// endpoints, "none" for endpoints (like DELETE) that return an empty
// body. We always read the response body on a non-OK status so the
// thrown Error includes the server's text/JSON error detail.
async function apiFetch(url, opts = {}, parse = "json") {
    const r = await fetch(url, {credentials: "same-origin", ...opts});
    if (!r.ok) {
        // Best-effort body read so the thrown error includes the
        // server's message. If the read itself fails (network blip,
        // body already consumed) note that, rather than producing
        // an empty-detail error that's harder to debug.
        let detail;
        try {
            detail = await r.text();
        } catch (readErr) {
            detail = `(could not read response body: ${readErr.message})`;
        }
        throw new Error(`${r.status} ${r.statusText}: ${detail}`);
    }
    if (parse === "none") return null;
    return await r.json();
}

async function listFiles() {
    const data = await apiFetch("/api/files");
    return data.files;
}

async function loadFile(path) {
    const data = await apiFetch("/api/files/" + encodePath(path));
    return data.content;
}

async function saveFile(path, content) {
    return await apiFetch("/api/files/" + encodePath(path), {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({content}),
    });
}

async function createFile(path) {
    return await apiFetch("/api/files/" + encodePath(path), {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({content: ""}),
    });
}

async function deleteFile(path) {
    return await apiFetch("/api/files/" + encodePath(path), {
        method: "DELETE",
    }, "none");
}

// ----------------------------------------------------------------- UI wiring

function renderFileList(listEl, files, onPick, current) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    for (const f of files) {
        const a = el("a", {href: "#", class: "file-link" + (f === current ? " current" : ""), text: f});
        a.addEventListener("click", (e) => {
            e.preventDefault();
            onPick(f);
        });
        listEl.appendChild(a);
    }
}

function buildShapeBar(editor) {
    const bar = document.getElementById("shape-bar");
    const shapes = [
        Lines.P, Lines.H1, Lines.H2, Lines.H3,
        Lines.LIST, Lines.QUOTE, Lines.LINK, Lines.PRE,
    ];
    for (const s of shapes) {
        const b = el("button", {type: "button", class: "shape-btn", "data-shape": s, text: SHAPE_LABEL[s]});
        b.addEventListener("click", () => editor.setShape(s));
        bar.appendChild(b);
    }
}

async function init() {
    const host = document.getElementById("editor-host");
    const status = document.getElementById("editor-status");
    const fileList = document.getElementById("file-list");
    const filenameEl = document.getElementById("current-file");
    const editor = new Editor(host, status);
    buildShapeBar(editor);

    let currentFile = null;

    async function refreshFileList() {
        const files = await listFiles();
        renderFileList(fileList, files, openFile, currentFile);
    }

    async function openFile(path) {
        if (editor.dirty) {
            if (!confirm("Discard unsaved changes?")) return;
        }
        try {
            const content = await loadFile(path);
            currentFile = path;
            editor.load(path, content);
            filenameEl.textContent = path;
            await refreshFileList();
        } catch (err) {
            editor.setStatus("Failed to load: " + err.message, "err");
        }
    }

    document.getElementById("btn-save").addEventListener("click", async () => {
        if (!currentFile) return;
        // Serialize once and reuse: the validation re-parse and the
        // network save both want the same body string, and the DOM
        // can't change between them.
        const body = editor.serialize();
        // Pre-save validation: an empty link URL would serialize to
        // `=> ` which is invalid per the Gemini spec and silently
        // dropped or mis-rendered by clients. Refuse the save and
        // tell the user instead.
        const badLink = parseGemtext(body).find(
            r => r.shape === Lines.LINK && !r.url.trim()
        );
        if (badLink) {
            editor.setStatus(
                "Cannot save: a link block has an empty URL. Fill it in or change the block to a paragraph.",
                "err",
            );
            return;
        }
        try {
            await saveFile(currentFile, body);
            editor.markSaved();
        } catch (err) {
            editor.setStatus("Save failed: " + err.message, "err");
        }
    });

    document.getElementById("btn-new").addEventListener("click", async () => {
        const name = prompt("New file (e.g. notes.gmi):");
        if (!name) return;
        const path = name.endsWith(".gmi") ? name : name + ".gmi";
        try {
            await createFile(path);
            await refreshFileList();
            await openFile(path);
        } catch (err) {
            editor.setStatus("Create failed: " + err.message, "err");
        }
    });

    document.getElementById("btn-delete").addEventListener("click", async () => {
        if (!currentFile) return;
        if (!confirm(`Delete ${currentFile}? This is permanent.`)) return;
        try {
            await deleteFile(currentFile);
            currentFile = null;
            filenameEl.textContent = "(no file)";
            host.innerHTML = "";
            editor.setStatus("Deleted");
            await refreshFileList();
        } catch (err) {
            editor.setStatus("Delete failed: " + err.message, "err");
        }
    });

    document.getElementById("btn-source").addEventListener("click", () => {
        if (!currentFile) return;
        const body = editor.serialize();
        const w = window.open("", "_blank");
        // Browsers block popups for non-user-initiated opens or
        // popup-blocked tabs; window.open returns null in that case.
        // Surface a clear error in the editor status bar instead of
        // crashing on `w.document` deref.
        if (w === null) {
            editor.setStatus("View source: popup blocked. Allow popups for this site.", "err");
            return;
        }
        w.document.write("<pre>" + body.replace(/[<>&]/g, c => ({"<": "&lt;", ">": "&gt;", "&": "&amp;"}[c])) + "</pre>");
        w.document.close();
    });

    window.addEventListener("beforeunload", (e) => {
        if (editor.dirty) {
            e.preventDefault();
            e.returnValue = "";
        }
    });

    // Initial state.
    try {
        const files = await listFiles();
        renderFileList(fileList, files, openFile, null);
        if (files.length > 0) await openFile(files[0]);
    } catch (err) {
        editor.setStatus("Failed to list files: " + err.message, "err");
    }
}

document.addEventListener("DOMContentLoaded", init);
