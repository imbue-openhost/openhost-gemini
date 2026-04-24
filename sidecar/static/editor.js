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
        this.host.addEventListener("paste", (e) => this.onPaste(e));
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

    // Intercept paste so a copy from a webpage / Markdown preview /
    // word processor lands as proper editor blocks instead of a
    // verbatim HTML dump that breaks the gemtext-shape model.
    //
    // The contenteditable host's default paste handling pastes
    // arbitrary HTML (or sometimes plain text, depending on the
    // browser) into the current block. That produces nested <span>s,
    // colour styles, fonts, and inline formatting that have no
    // gemtext equivalent and that survive in the DOM long enough to
    // break the next save's serialize step. By intercepting paste we
    // map clipboard content to gemtext-shape blocks and replace the
    // current selection with those.
    //
    // Strategy:
    //   1. If the clipboard has text/html, parse it with
    //      DOMParser and walk its block-level descendants, mapping
    //      each to a gemtext record (or a sequence of records).
    //   2. If only text/plain is present, run it through the
    //      gemtext parser directly: any text the user pastes is
    //      treated as if they typed gemtext, so the existing
    //      shape detection (`#`, `*`, `=>`, etc.) works.
    //   3. If we end up with no records, fall back to the browser's
    //      default plain-text paste so users don't lose their
    //      clipboard mid-operation.
    onPaste(e) {
        const cd = e.clipboardData;
        if (!cd) return; // Edge cases (Safari quirks); fall through to default.
        const html = cd.getData("text/html");
        const text = cd.getData("text/plain");
        let records = [];
        if (html && html.trim()) {
            records = htmlToRecords(html);
        }
        if (records.length === 0 && text) {
            records = parseGemtext(text);
        }
        if (records.length === 0) return; // Image-only paste, etc.
        e.preventDefault();
        this.insertRecordsAtSelection(records);
        this.markDirty();
    }

    // Replace the current selection with a sequence of gemtext records,
    // mapping each to its corresponding editor block. We split the
    // current block at the caret if the paste happens mid-text:
    //   - Text before the caret stays in the current block.
    //   - Pasted records get inserted as new blocks after it.
    //   - Text after the caret moves into a trailing paragraph block.
    insertRecordsAtSelection(records) {
        const block = this.currentBlock();
        if (!block) {
            // Caret is outside any block (empty editor, etc.). Just
            // append the records at the end.
            for (const r of records) this.host.appendChild(blockFor(r));
            return;
        }
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) {
            // Selection lost (rare). Insert after the current block.
            const after = block.nextSibling;
            for (const r of records) {
                const node = blockFor(r);
                this.host.insertBefore(node, after);
            }
            return;
        }
        // Split the current block at the caret. We capture the text
        // before/after the caret as plain strings; for non-plain
        // shapes (link, list, pre) we don't try to be clever -- the
        // caret-position split only really makes sense for paragraph
        // / heading / quote shapes. For those special shapes we
        // insert the new blocks AFTER the current one without
        // splitting.
        const range = sel.getRangeAt(0);
        // Drop any selection content that the paste replaces.
        if (!range.collapsed) range.deleteContents();
        const shape = block.dataset.shape;
        const splittable = shape === Lines.P || shape === Lines.H1 ||
                           shape === Lines.H2 || shape === Lines.H3 ||
                           shape === Lines.QUOTE;
        let insertAfter = block;
        if (splittable) {
            // Walk the block's text content, splitting at the caret.
            const before = document.createRange();
            before.selectNodeContents(block);
            before.setEnd(range.startContainer, range.startOffset);
            const beforeText = before.toString();

            const after = document.createRange();
            after.selectNodeContents(block);
            after.setStart(range.startContainer, range.startOffset);
            const afterText = after.toString();

            // Preserve the original block, now containing only the
            // text before the caret. If that's empty, replace it
            // with a placeholder paragraph rather than leaving a
            // visually-empty heading/quote.
            block.textContent = beforeText;
            if (beforeText === "" && shape !== Lines.P) {
                const placeholder = blockFor({shape: Lines.P, text: ""});
                block.replaceWith(placeholder);
                insertAfter = placeholder;
            }
            // The "after" text becomes a fresh paragraph block AFTER
            // the pasted records, so the user's caret naturally lands
            // back in their original text once the paste settles.
            if (afterText !== "") {
                const tail = blockFor({shape: Lines.P, text: afterText});
                // Defer adding tail until after the pasted records.
                this._pendingTail = tail;
            }
        }
        // Insert each pasted record after the (possibly split) block.
        let cursor = insertAfter;
        for (const r of records) {
            const node = blockFor(r);
            cursor.after(node);
            cursor = node;
        }
        if (this._pendingTail) {
            cursor.after(this._pendingTail);
            cursor = this._pendingTail;
            this._pendingTail = null;
        }
        // Place the cursor at the end of the last inserted block so
        // the user can keep typing.
        const finalRange = document.createRange();
        finalRange.selectNodeContents(cursor);
        finalRange.collapse(false);
        sel.removeAllRanges();
        sel.addRange(finalRange);
    }
}

// ------------------------------------------------------------- HTML -> records
//
// Map a pasted HTML fragment to gemtext records. We do not try to
// preserve inline formatting (bold/italic/code spans) because gemtext
// has no inline markup; instead we collapse each block-level element
// to plain text and pick the closest gemtext shape:
//
//   <h1..h3>          -> Heading 1..3
//   <h4..h6>          -> Heading 3 (clamped)
//   <p>, <div>, plain -> Paragraph
//   <li>              -> List item
//   <blockquote>      -> Quote
//   <pre>             -> Preformatted
//   <a> at block top  -> Link block (one record)
//   <a> inside text   -> Inlined as "text (URL)" so we don't lose URLs
//   <hr>              -> Empty paragraph (visual separator)
//   <br>              -> Splits the surrounding block into two records
//   <img>             -> Link block to the image's src (gemtext doesn't
//                         do inline images; a link is the closest
//                         analogue clients render usefully)
//
// Unknown elements are descended into so a <article><p>...</p></article>
// still produces the inner paragraph.
export function htmlToRecords(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    walkBlock(doc.body, out);
    return collapseEmpty(out);
}

// Some sources (Word, Google Docs) wrap everything in repeated empty
// paragraphs. Strip leading and trailing empties and collapse runs of
// 2+ empty paragraphs to a single one so the pasted content reads
// cleanly.
function collapseEmpty(records) {
    const trimmed = records.slice();
    while (trimmed.length && isEmptyP(trimmed[0])) trimmed.shift();
    while (trimmed.length && isEmptyP(trimmed[trimmed.length - 1])) trimmed.pop();
    const out = [];
    let lastWasEmpty = false;
    for (const r of trimmed) {
        const empty = isEmptyP(r);
        if (empty && lastWasEmpty) continue;
        out.push(r);
        lastWasEmpty = empty;
    }
    return out;
}

function isEmptyP(r) {
    return r && r.shape === Lines.P && (!r.text || !r.text.trim());
}

// Walk an element's children, emitting records as we go. The function
// looks at the element's tag and dispatches to the appropriate
// converter. For unknown tags we just recurse so a wrapping <div>
// doesn't swallow its descendants.
function walkBlock(el, out) {
    if (!el) return;
    for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            const text = child.textContent.replace(/\s+/g, " ");
            if (text.trim()) {
                // Loose text directly under the body / a wrapper:
                // promote to a paragraph.
                appendOrExtendParagraph(out, text);
            }
            continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName.toLowerCase();
        switch (tag) {
            case "h1":
                out.push({shape: Lines.H1, text: blockText(child)});
                break;
            case "h2":
                out.push({shape: Lines.H2, text: blockText(child)});
                break;
            case "h3":
            case "h4":
            case "h5":
            case "h6":
                out.push({shape: Lines.H3, text: blockText(child)});
                break;
            case "blockquote":
                // Multi-line blockquotes become one quote record per
                // visible line so each maps cleanly to a `>` line in
                // gemtext.
                for (const line of blockTextLines(child)) {
                    out.push({shape: Lines.QUOTE, text: line});
                }
                break;
            case "ul":
            case "ol":
                for (const li of child.querySelectorAll(":scope > li")) {
                    out.push({shape: Lines.LIST, text: blockText(li)});
                }
                break;
            case "li":
                // Stray <li> outside a list: still represent as a list item.
                out.push({shape: Lines.LIST, text: blockText(child)});
                break;
            case "pre":
                out.push({shape: Lines.PRE, alt: "", body: child.textContent.replace(/\n+$/, "")});
                break;
            case "p":
            case "div":
            case "section":
            case "article":
            case "main":
            case "aside":
            case "header":
            case "footer":
                // Block-level wrappers: collect their text as a
                // paragraph (or recurse if they contain block-level
                // children themselves -- common with Google Docs
                // dumps).
                if (containsBlockChild(child)) {
                    walkBlock(child, out);
                } else {
                    const text = blockText(child);
                    if (text) out.push({shape: Lines.P, text});
                }
                break;
            case "br":
                // Hard line break: end the current paragraph if any.
                appendOrExtendParagraph(out, "\n");
                break;
            case "hr":
                out.push({shape: Lines.P, text: ""});
                break;
            case "a": {
                // A bare link at block level becomes its own link block.
                // A link surrounded by other inline content stays inline
                // -- handled by blockText in the parent walk -- so we
                // only get here when <a> is a direct child of body /
                // a wrapper.
                const url = (child.getAttribute("href") || "").trim();
                const label = blockText(child);
                if (url) out.push({shape: Lines.LINK, url, label});
                else if (label) appendOrExtendParagraph(out, label);
                break;
            }
            case "img": {
                const src = (child.getAttribute("src") || "").trim();
                const alt = (child.getAttribute("alt") || "").trim();
                if (src) out.push({shape: Lines.LINK, url: src, label: alt || "image"});
                break;
            }
            case "script":
            case "style":
            case "head":
            case "meta":
            case "link":
                // Drop entirely. (Browsers paste these in some cases.)
                break;
            default:
                // Anything else: treat as a wrapper and recurse.
                walkBlock(child, out);
        }
    }
}

// Append text to the last record if it's a paragraph still being
// built; otherwise start a new paragraph. Used for stray text and <br>.
function appendOrExtendParagraph(out, text) {
    const last = out[out.length - 1];
    if (last && last.shape === Lines.P) {
        last.text = (last.text + text).replace(/\s+/g, " ").trim();
    } else {
        const cleaned = text.replace(/\s+/g, " ").trim();
        if (cleaned) out.push({shape: Lines.P, text: cleaned});
    }
}

// Extract a single line of plain text from an element, with inline
// links rendered as "label (url)" so URLs aren't lost. Whitespace is
// collapsed to single spaces (gemtext is line-oriented; soft wraps
// from the source HTML are noise).
function blockText(el) {
    let out = "";
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            out += node.textContent;
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = node.tagName.toLowerCase();
        if (tag === "a") {
            const url = (node.getAttribute("href") || "").trim();
            const label = blockText(node);
            if (url && label && url !== label) {
                out += `${label} (${url})`;
            } else {
                out += label || url;
            }
            continue;
        }
        if (tag === "br") {
            out += " ";
            continue;
        }
        if (tag === "img") {
            const alt = (node.getAttribute("alt") || "").trim();
            if (alt) out += alt;
            continue;
        }
        if (tag === "script" || tag === "style") continue;
        out += blockText(node);
    }
    return out.replace(/\s+/g, " ").trim();
}

// Like blockText but splits on <br> so a multi-line <blockquote>
// turns into separate quote records.
function blockTextLines(el) {
    const html = el.innerHTML.replace(/<br\s*\/?>/gi, "\n");
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent.split(/\n+/).map(s => s.trim()).filter(Boolean);
}

function containsBlockChild(el) {
    return !!el.querySelector(":scope > p, :scope > div, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > ul, :scope > ol, :scope > pre, :scope > blockquote, :scope > section, :scope > article");
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
