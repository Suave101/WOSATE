// Real-time co-editing over Yjs. A shared Y.Doc holds every workspace file
// as Y.Text; peers connect with WebRTC (y-webrtc), so no application server
// is needed and the site stays static. Tabs of the same browser sync through
// BroadcastChannel even without a signaling server.

import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";

const COLORS = ["#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd", "#56b6c2", "#d19a66", "#be5046"];

export function randomRoom() {
  const words = ["amber", "brisk", "cedar", "delta", "ember", "fjord", "gale", "harbor", "ivory", "juniper", "kestrel", "lumen", "maple", "nova", "onyx", "pine", "quartz", "raven", "sierra", "tundra"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

/** Apply `next` to a Y.Text as one minimal splice (common prefix / suffix kept). */
function setText(ytext, next) {
  const cur = ytext.toString();
  if (cur === next) return;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length, endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
    endCur--;
    endNext--;
  }
  if (endCur > start) ytext.delete(start, endCur - start);
  if (endNext > start) ytext.insert(start, next.slice(start, endNext));
}

export class Collaboration {
  /**
   * @param {{ room: string, password?: string, signaling?: string[], user: string,
   *   onFiles: (files: {name,text}[]) => void, onPeers: (n: number) => void }} opts
   */
  constructor({ room, password, signaling, user, onFiles, onPeers, createProvider }) {
    this.room = room;
    this.doc = new Y.Doc();
    this.files = this.doc.getMap("files");
    // `createProvider` lets tests connect documents without WebRTC.
    this.provider = createProvider ? createProvider(this.doc) : new WebrtcProvider(`wosate-${room}`, this.doc, {
      password: password || undefined,
      ...(signaling?.length ? { signaling } : {}),
    });
    this.awareness = this.provider.awareness;
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    this.awareness.setLocalStateField("user", { name: user || "Engineer", color, colorLight: `${color}33` });
    this.onFiles = onFiles;
    this.files.observeDeep((_events, tx) => {
      if (tx.origin === this) return;
      this.onFiles(this.snapshot());
    });
    const peers = () => onPeers?.(this.awareness.getStates().size);
    this.awareness.on("change", peers);
    peers();
  }

  snapshot() {
    return [...this.files.entries()].map(([name, text]) => ({ name, text: text.toString() })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Start sharing. If the room already has files (someone else is hosting) they win;
   * otherwise this workspace seeds the room. Waits briefly for peers to sync first.
   */
  async start(localFiles, { waitMs = 1500 } = {}) {
    await new Promise((resolve) => {
      if (this.files.size) return resolve();
      const first = () => {
        clearTimeout(t);
        this.files.unobserve(first);
        resolve();
      };
      const t = setTimeout(() => {
        this.files.unobserve(first);
        resolve();
      }, waitMs);
      this.files.observe(first);
    });
    if (this.files.size) {
      this.onFiles(this.snapshot());
      return "joined";
    }
    this.push(localFiles);
    return "hosting";
  }

  /** Bring the shared document in line with the local workspace files. */
  push(files) {
    this.doc.transact(() => {
      const names = new Set(files.map((f) => f.name));
      for (const f of files) {
        let t = this.files.get(f.name);
        if (!t) {
          t = new Y.Text();
          this.files.set(f.name, t);
        }
        setText(t, f.text);
      }
      for (const name of [...this.files.keys()]) if (!names.has(name)) this.files.delete(name);
    }, this);
  }

  ytext(name) {
    return this.files.get(name) || null;
  }

  peers() {
    return [...this.awareness.getStates().entries()].map(([id, s]) => ({ id, self: id === this.doc.clientID, ...(s.user || {}) }));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.provider.destroy();
    this.doc.destroy();
  }
}
