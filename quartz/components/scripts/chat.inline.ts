/**
 * Gnosis chat widget — client-side interactivity.
 *
 * Handles open/close, input, SSE streaming from /api/ask, and rendering of
 * streamed markdown responses with [[wiki-link]] citations converted to
 * clickable anchors.
 */

type Msg = { role: "user" | "assistant"; content: string }

const STATE: { messages: Msg[]; inFlight: boolean } = {
  messages: [],
  inFlight: false,
}

// ---- tiny markdown-ish renderer (bold, italic, inline code, lists, links, wiki-links) ----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function renderInline(s: string): string {
  let out = escapeHtml(s)
  // wiki-links: [[slug]] -> <a href="/slug">slug</a>
  out = out.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, slug, label) => {
    const href = "/" + String(slug).replace(/^\//, "")
    const text = label || String(slug).split("/").pop()
    return `<a href="${href}" class="gnosis-chat-citation">${escapeHtml(String(text))}</a>`
  })
  // markdown links: [text](url)
  out = out.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, (_m, text, url) => {
    const safeUrl = String(url).replace(/"/g, "%22")
    return `<a href="${safeUrl}" target="_blank" rel="noopener">${text}</a>`
  })
  // bold **x**
  out = out.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
  // inline code `x`
  out = out.replace(/`([^`]+?)`/g, "<code>$1</code>")
  // italic *x* (loose)
  out = out.replace(/(^|[\s(])\*([^\s*][^*]*?)\*(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>")
  return out
}

function renderMarkdown(s: string): string {
  // split into blocks by blank lines
  const blocks = s.split(/\n\n+/)
  return blocks
    .map((block) => {
      const lines = block.split("\n")
      // bullet list?
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const items = lines
          .map((l) => l.replace(/^\s*[-*]\s+/, ""))
          .map((l) => `<li>${renderInline(l)}</li>`)
          .join("")
        return `<ul>${items}</ul>`
      }
      // numbered list?
      if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
        const items = lines
          .map((l) => l.replace(/^\s*\d+\.\s+/, ""))
          .map((l) => `<li>${renderInline(l)}</li>`)
          .join("")
        return `<ol>${items}</ol>`
      }
      // plain paragraph: collapse inline newlines
      return `<p>${renderInline(lines.join(" "))}</p>`
    })
    .join("")
}

// ---- DOM helpers ----

function $(sel: string, root: Document | Element = document): HTMLElement | null {
  return root.querySelector(sel) as HTMLElement | null
}

function addMessage(role: "user" | "assistant", content: string): HTMLElement {
  const list = $("#gnosis-chat-messages")!
  // remove empty state if present
  const empty = list.querySelector(".gnosis-chat-empty")
  if (empty) empty.remove()

  const wrap = document.createElement("div")
  wrap.className = `gnosis-chat-msg gnosis-chat-msg-${role}`
  const bubble = document.createElement("div")
  bubble.className = "gnosis-chat-bubble"
  if (role === "user") {
    bubble.textContent = content
  } else {
    bubble.innerHTML = renderMarkdown(content || "")
  }
  wrap.appendChild(bubble)
  list.appendChild(wrap)
  list.scrollTop = list.scrollHeight
  return bubble
}

// ---- streaming request ----

async function sendMessage(userText: string) {
  if (STATE.inFlight) return
  const text = userText.trim()
  if (!text) return

  STATE.inFlight = true
  STATE.messages.push({ role: "user", content: text })
  addMessage("user", text)

  const input = $("#gnosis-chat-input") as HTMLTextAreaElement | null
  if (input) {
    input.value = ""
    input.style.height = "auto"
  }

  const assistantBubble = addMessage("assistant", "")
  assistantBubble.classList.add("gnosis-chat-streaming")
  assistantBubble.innerHTML = '<span class="gnosis-chat-dots"><span></span><span></span><span></span></span>'

  let assistantText = ""
  let firstChunk = true

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: STATE.messages }),
    })
    if (!res.ok || !res.body) {
      const errText = await res.text()
      assistantBubble.innerHTML = `<em>Error: ${escapeHtml(errText || res.statusText)}</em>`
      STATE.inFlight = false
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""
      for (const raw of lines) {
        if (!raw.startsWith("data:")) continue
        const payload = raw.slice(5).trim()
        if (payload === "[DONE]") continue
        try {
          const obj = JSON.parse(payload)
          if (obj.text) {
            if (firstChunk) {
              assistantBubble.innerHTML = ""
              firstChunk = false
            }
            assistantText += obj.text
            assistantBubble.innerHTML = renderMarkdown(assistantText)
            const list = $("#gnosis-chat-messages")!
            list.scrollTop = list.scrollHeight
          } else if (obj.error) {
            assistantBubble.innerHTML = `<em>Error: ${escapeHtml(obj.error)}</em>`
          }
        } catch {
          // ignore non-JSON keepalives
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    assistantBubble.innerHTML = `<em>Error: ${escapeHtml(msg)}</em>`
  } finally {
    assistantBubble.classList.remove("gnosis-chat-streaming")
    STATE.messages.push({ role: "assistant", content: assistantText })
    STATE.inFlight = false
  }
}

// ---- wire up on DOM ready (Quartz runs this on each SPA nav via afterDOMLoaded) ----

function init() {
  const root = $("#gnosis-chat")
  if (!root) return

  // Idempotent: Quartz fires `nav` on first load AND on SPA nav, and we also
  // call init() directly to catch scripts that loaded after the first `nav`.
  // Without a guard, handlers bind twice on first load and cancel each other
  // out (toggle → toggle → no net change). Mark the root once we've wired it.
  if (root.dataset.gnosisChatReady === "1") return
  root.dataset.gnosisChatReady = "1"

  const toggle = $("#gnosis-chat-toggle")
  const close = $("#gnosis-chat-close")
  const form = $("#gnosis-chat-form") as HTMLFormElement | null
  const input = $("#gnosis-chat-input") as HTMLTextAreaElement | null

  const openPanel = () => {
    root.classList.remove("collapsed")
    root.classList.add("expanded")
    input?.focus()
  }
  const closePanel = () => {
    root.classList.remove("expanded")
    root.classList.add("collapsed")
  }

  toggle?.addEventListener("click", openPanel)
  close?.addEventListener("click", closePanel)

  form?.addEventListener("submit", (e) => {
    e.preventDefault()
    if (input) sendMessage(input.value)
  })

  // Enter to send, Shift+Enter for newline
  input?.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent
    if (ke.key === "Enter" && !ke.shiftKey) {
      ke.preventDefault()
      if (input) sendMessage(input.value)
    }
  })

  // Auto-grow textarea
  input?.addEventListener("input", () => {
    if (!input) return
    input.style.height = "auto"
    input.style.height = Math.min(input.scrollHeight, 140) + "px"
  })

  // Suggestion chips — auto-open panel when clicked from empty state
  root.querySelectorAll<HTMLButtonElement>(".gnosis-chat-suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
      const prompt = btn.dataset.prompt || btn.textContent || ""
      if (!root.classList.contains("expanded")) openPanel()
      sendMessage(prompt)
    })
  })
}

// Quartz dispatches `nav` on SPA navigation AND on the first page load (after
// DOMContentLoaded). Listen once; don't also call init() synchronously,
// which races the initial `nav` and double-binds handlers.
document.addEventListener("nav", init)
// Safety net: if `nav` never fires (plain-HTML fallback), still initialize
// once DOM is parsed. The idempotency guard above prevents double-binding.
if (document.readyState !== "loading") {
  init()
} else {
  document.addEventListener("DOMContentLoaded", init, { once: true })
}
