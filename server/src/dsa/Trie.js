/**
 * Prefix trie mapping tokens -> set of record ids.
 *   insert / remove : O(L)            (L = token length)
 *   prefix search   : O(P + matches)  (DFS below the prefix node, capped)
 *
 * Used for type-ahead search over destination numbers, countries,
 * products and billing-group names.
 */
class TrieNode {
  constructor() {
    this.children = new Map();
    this.ids = null; // Set<string> only on terminal nodes
  }
}

export class Trie {
  constructor() {
    this.root = new TrieNode();
    this.tokens = 0;
  }

  static normalize(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  insert(token, id) {
    const key = Trie.normalize(token);
    if (!key) return;
    let node = this.root;
    for (const ch of key) {
      let next = node.children.get(ch);
      if (!next) { next = new TrieNode(); node.children.set(ch, next); }
      node = next;
    }
    if (!node.ids) { node.ids = new Set(); this.tokens++; }
    node.ids.add(id);
  }

  remove(token, id) {
    const key = Trie.normalize(token);
    if (!key) return;
    // Walk down recording the path so empty branches can be pruned.
    const path = [this.root];
    let node = this.root;
    for (const ch of key) {
      node = node.children.get(ch);
      if (!node) return;
      path.push(node);
    }
    if (!node.ids) return;
    node.ids.delete(id);
    if (node.ids.size) return;
    node.ids = null;
    this.tokens--;
    for (let i = key.length - 1; i >= 0; i--) {
      const child = path[i + 1];
      if (child.ids || child.children.size) break;
      path[i].children.delete(key[i]);
    }
  }

  /** Union of ids for every token starting with `prefix`, capped at `limit`. */
  searchPrefix(prefix, limit = 10_000) {
    const key = Trie.normalize(prefix);
    const out = new Set();
    if (!key) return out;
    let node = this.root;
    for (const ch of key) {
      node = node.children.get(ch);
      if (!node) return out;
    }
    const stack = [node];
    while (stack.length && out.size < limit) {
      const n = stack.pop();
      if (n.ids) for (const id of n.ids) { out.add(id); if (out.size >= limit) break; }
      for (const child of n.children.values()) stack.push(child);
    }
    return out;
  }

  /** Distinct completions for autocomplete (BFS so shorter tokens come first). */
  suggest(prefix, limit = 8) {
    const key = Trie.normalize(prefix);
    let node = this.root;
    for (const ch of key) {
      node = node.children.get(ch);
      if (!node) return [];
    }
    const out = [];
    const queue = [[node, key]];
    while (queue.length && out.length < limit) {
      const [n, word] = queue.shift();
      if (n.ids && word) out.push({ token: word, count: n.ids.size });
      for (const [ch, child] of n.children) queue.push([child, word + ch]);
    }
    return out;
  }
}
