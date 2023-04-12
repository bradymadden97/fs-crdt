type Op = {
  id: string;
  key: string;
  peer: Peer;
  timestamp: number;
  deleted?: boolean;
  value?: number;
};
type Origin = "local" | "remote";
type Observer = (e: { op: Op; origin: Origin; oldValue?: number }) => void;

class DB {
  _peer: Peer;
  _rows: Map<string, Map<string, Op>>;
  _observers: Array<Observer>;

  constructor(peer: Peer) {
    this._peer = peer;
    this._rows = new Map();
    this._observers = [];
  }

  afterApply(observer: Observer) {
    this._observers.push(observer);
  }

  get ids() {
    return [...this._rows.keys()];
  }

  get(id: string, key: string) {
    const row = this._rows.get(id);
    const field = row && row.get(key);
    return field && field.value;
  }

  set(id: string, key: string, value: number) {
    const op = { id, key, value, peer: this._peer, timestamp: Date.now() };
    const row = this._rows.get(id);
    const field = row && row.get(key);
    if (field) {
      // Make sure "set" always overwrites locally.
      op.timestamp = Math.max(op.timestamp, field.timestamp + 1);
    }
    this.apply(op, "local");
  }

  delete(id: string, key: string) {
    const op = {
      id,
      key,
      deleted: true,
      peer: this._peer,
      timestamp: Date.now(),
    };
    const row = this._rows.get(id);
    const field = row && row.get(key);
    if (field) {
      // Make sure "set" always overwrites locally.
      op.timestamp = Math.max(op.timestamp, field.timestamp + 1);
    }
    this.apply(op, "local");
  }

  apply(op: Op, origin: Origin) {
    let row = this._rows.get(op.id);
    if (!row) {
      row = new Map();
      this._rows.set(op.id, row);
    }
    const field = row.get(op.key);
    if (
      field &&
      (field.timestamp > op.timestamp ||
        (field.timestamp === op.timestamp && field.peer > op.peer))
    ) {
      // Don't overwrite newer values with older values. The last writer always wins.
    } else if (op.deleted) {
      // TODO: Perhaps different strategy than LWW?
      row.set(op.key, {
        id: op.id,
        key: op.key,
        peer: op.peer,
        timestamp: op.timestamp,
        deleted: true,
      });
    } else {
      row.set(op.key, {
        id: op.id,
        key: op.key,
        peer: op.peer,
        timestamp: op.timestamp,
        value: op.value,
      });
    }
    for (const observer of this._observers) {
      observer({ op, origin, oldValue: field && field.value });
    }
  }
}

class UndoRedo {
  constructor(db, { onlyKeys } = {}) {
    this.db = db;
    this.undoHistory = [];
    this.redoHistory = [];
    this._onlyKeys = onlyKeys && new Set(onlyKeys);
    this._isBusy = false;
    this._pending = [];
    this._depth = 0;

    db.afterApply(({ op, origin, oldValue }) => {
      if (
        origin === "local" &&
        !this._isBusy &&
        (!this._onlyKeys || this._onlyKeys.has(op.key))
      ) {
        this._pending.push({ id: op.id, key: op.key, value: oldValue });
        this._commit();
      }
    });
  }

  batch(callback) {
    this._depth++;
    callback();
    this._depth--;
    this._commit();
  }

  undo() {
    const top = this.undoHistory.pop();
    if (top) this.redoHistory.push(this._apply(top));
  }

  redo() {
    const top = this.redoHistory.pop();
    if (top) this.undoHistory.push(this._apply(top));
  }

  _commit() {
    if (this._depth === 0) {
      this.undoHistory.push(this._pending);
      this.redoHistory = [];
      this._pending = [];
    }
  }

  _apply(changes) {
    const reverse = [];
    this._isBusy = true;
    for (const { id, key, value } of changes) {
      reverse.push({ id, key, value: this.db.get(id, key) });
      this.db.set(id, key, value);
    }
    this._isBusy = false;
    return reverse.reverse();
  }
}

class Tree {
  nodes: Map;
  constructor(db) {
    this.newNodeWithID = (id) => ({
      id,
      parent: null,
      children: [],
      edges: new Map(),
      cycle: null,
    });
    this.db = db;
    this.root = this.newNodeWithID("(ROOT)");
    this.nodes = new Map();
    this.nodes.set(this.root.id, this.root);

    // Keep the in-memory tree up to date and cycle-free as the database is mutated
    db.afterApply(({ op }) => {
      // Each mutation takes place on the child. The key is the parent
      // identifier and the value is the counter for that graph edge.
      let child = this.nodes.get(op.id);
      if (!child) {
        // Make sure the child exists
        child = this.newNodeWithID(op.id);
        this.nodes.set(op.id, child);
      }
      if (!this.nodes.has(op.key)) {
        // Make sure the parent exists
        this.nodes.set(op.key, this.newNodeWithID(op.key));
      }
      if (op.deleted) {
        child.edges.delete(op.key);
      } else if (op.value === undefined) {
        // Undo can revert a value back to undefined
        child.edges.delete(op.key);
      } else {
        // Otherwise, add an edge from the child to the parent
        child.edges.set(op.key, op.value);
      }
      this.recomputeParentsAndChildren();
    });
  }

  recomputeParentsAndChildren() {
    // Start off with all children arrays empty and each parent pointer
    // for a given node set to the most recent edge for that node.
    for (const node of this.nodes.values()) {
      // Set the parent identifier to the link with the largest counter
      node.parent = this.nodes.get(edgeWithLargestCounter(node)) || null;
      node.children = [];
    }

    // At this point all nodes that can reach the root form a tree (by
    // construction, since each node other than the root has a single
    // parent). The parent pointers for the remaining nodes may form one
    // or more cycles. Gather all remaining nodes detached from the root.
    const nonRootedNodes = new Set();
    for (let node of this.nodes.values()) {
      if (!isNodeUnderOtherNode(node, this.root)) {
        while (node && !nonRootedNodes.has(node)) {
          nonRootedNodes.add(node);
          node = node.parent;
        }
      }
    }

    // Deterministically reattach these nodes to the tree under the root
    // node. The order of reattachment is arbitrary but needs to be based
    // only on information in the database so that all peers reattach
    // non-rooted nodes in the same order and end up with the same tree.
    if (nonRootedNodes.size > 0) {
      // All "ready" edges already have the parent connected to the root,
      // and all "deferred" edges have a parent not yet connected to the
      // root. Prioritize newer edges over older edges using the counter.
      const deferredEdges = new Map();
      const readyEdges = new PriorityQueue((a, b) => {
        const counterDelta = b.counter - a.counter;
        if (counterDelta !== 0) return counterDelta;
        if (a.parent.id < b.parent.id) return -1;
        if (a.parent.id > b.parent.id) return 1;
        if (a.child.id < b.child.id) return -1;
        if (a.child.id > b.child.id) return 1;
        return 0;
      });
      for (const child of nonRootedNodes) {
        for (const [parentID, counter] of child.edges) {
          const parent = this.nodes.get(parentID);
          if (!nonRootedNodes.has(parent)) {
            readyEdges.push({ child, parent, counter });
          } else {
            let edges = deferredEdges.get(parent);
            if (!edges) {
              edges = [];
              deferredEdges.set(parent, edges);
            }
            edges.push({ child, parent, counter });
          }
        }
      }
      for (let top; (top = readyEdges.pop()); ) {
        // Skip nodes that have already been reattached
        const child = top.child;
        if (!nonRootedNodes.has(child)) continue;

        // Reattach this node
        child.parent = top.parent;
        nonRootedNodes.delete(child);

        // Activate all deferred edges for this node
        const edges = deferredEdges.get(child);
        if (edges) for (const edge of edges) readyEdges.push(edge);
      }
    }

    // Add items as children of their parents so that the rest of the app
    // can easily traverse down the tree for drawing and hit-testing
    for (const node of this.nodes.values()) {
      if (node.parent) {
        node.parent.children.push(node);
      }
    }

    // Sort each node's children by their identifiers so that all peers
    // display the same tree. In this demo, the ordering of siblings
    // under the same parent is considered unimportant. If this is
    // important for your app, you will need to use another CRDT in
    // combination with this CRDT to handle the ordering of siblings.
    for (const node of this.nodes.values()) {
      node.children.sort((a, b) => {
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });
    }
  }

  addChildToParent(childID, parentID) {
    const ensureNodeIsRooted = (child) => {
      while (child) {
        const parent = child.parent;
        if (!parent) break;
        const edge = edgeWithLargestCounter(child);
        if (edge !== parent.id) edits.push([child, parent]);
        child = parent;
      }
    };

    // Ensure that both the old and new parents remain where they are
    // in the tree after the edit we are about to make. Then move the
    // child from its old parent to its new parent.
    const edits = [];
    let child = this.nodes.get(childID);

    // If the child doesn't exist we create it?
    if (!child) {
      this.nodes.set(childID, this.newNodeWithID(childID));
      child = this.nodes.get(childID);
      child.edges.set(childID, parentID);
      this.recomputeParentsAndChildren();
    }

    const parent = this.nodes.get(parentID);
    ensureNodeIsRooted(child.parent);
    ensureNodeIsRooted(parent);
    edits.push([child, parent]);

    // Apply all database edits accumulated above. If your database
    // supports syncing a set of changes in a single batch, then these
    // edits should all be part of the same batch for efficiency. The
    // order that these edits are made in shouldn't matter.
    for (const [child, parent] of edits) {
      let maxCounter = -1;
      for (const counter of child.edges.values()) {
        maxCounter = Math.max(maxCounter, counter);
      }
      this.db.set(child.id, parent.id, maxCounter + 1);
    }
  }

  editChild(childID, newID) {
    // TODO - this is just hacking something in

    const child = this.nodes.get(childID);
    const parent = child.parent;

    this.nodes.set(newID, this.newNodeWithID(newID));
    let newChild = this.nodes.get(newID);
    newChild.edges.set(newID, parent.id);

    for (const node of child.children) {
      node.edges.delete(child.id);
      node.edges.set(node.id, newID);
      this.recomputeParentsAndChildren();
    }

    this.db.set(newID, parent.id, 0);
    // this.db.remove(childID, parent.id);
  }
}

// Note: This priority queue implementation is inefficient. It should
// probably be implemented using a heap instead. This only matters when
// there area large numbers of edges on nodes involved in cycles.
class PriorityQueue {
  constructor(compare) {
    this.compare = compare;
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    this.items.sort(this.compare);
  }
  pop() {
    return this.items.shift();
  }
}

// The edge with the largest counter is considered to be the most recent
// one. If two edges are set simultaneously, the identifier breaks the tie.
function edgeWithLargestCounter(node) {
  let edgeID = null;
  let largestCounter = -1;
  for (const [id, counter] of node.edges) {
    if (
      counter > largestCounter ||
      (counter === largestCounter && id > edgeID)
    ) {
      edgeID = id;
      largestCounter = counter;
    }
  }
  return edgeID;
}

// Returns true if and only if "node" is in the subtree under "other".
// This function is safe to call in the presence of parent cycles.
function isNodeUnderOtherNode(node, other) {
  if (node === other) return true;
  let tortoise = node;
  let hare = node.parent;
  while (hare && hare !== other) {
    if (tortoise === hare) return false; // Cycle detected
    hare = hare.parent;
    if (!hare || hare === other) break;
    tortoise = tortoise.parent;
    hare = hare.parent;
  }
  return hare === other;
}

let previousFrame = Date.now();

class Peer {
  db: DB;
  tree: Tree;

  constructor(private id: string) {
    this.id = id;
    this.x = 0;
    this.y = 0;
    this.w = 0;
    this.h = 0;
    this.peerX = 0;
    this.peerY = 0;
    this.db = new DB(id);
    this.tree = new Tree(this.db);
    this.undoRedo = new UndoRedo(this.db);
    this.animatedTreeNodes = new Map();
    this.draggingID = null;
    this.draggingMouse = null;
    this.dropID = null;
  }
}

const isMobile = true;
const peers = isMobile
  ? [new Peer("Peer 1"), new Peer("Peer 2")]
  : [
      new Peer("Peer 1"),
      new Peer("Peer 2"),
      new Peer("Peer 3"),
      new Peer("Peer 4"),
    ];

// Seed some initial data
setTimeout(() => {
  peers[0].db.set("src", peers[0].tree.root.id, 0);
  peers[0].undoRedo.undoHistory = [];
}, 100);
setTimeout(() => {
  peers[0].db.set("test", peers[0].tree.root.id, 0);
  peers[0].undoRedo.undoHistory = [];
}, 200);
setTimeout(() => {
  peers[0].db.set("app", "src", 0);
  peers[0].undoRedo.undoHistory = [];
}, 300);
setTimeout(() => {
  peers[0].db.set("crdt.js", "src", 0);
  peers[0].undoRedo.undoHistory = [];
}, 400);
setTimeout(() => {
  peers[0].db.set("index.test.js", "test", 0);
  peers[0].undoRedo.undoHistory = [];
}, 500);
setTimeout(() => {
  peers[0].db.set("crdt.test.js", "test", 0);
  peers[0].undoRedo.undoHistory = [];
}, 600);

// Simulate network traffic

//   const updateNetworkSim = seconds => {
//     const oldPackets = packets
//     packets = []
//     for (const packet of oldPackets) {
//       if (enableNetwork) packet.life += seconds
//       if (packet.life < packet.lifetime) packets.push(packet)
//       else for (const peer of peers) if (peer.id === packet.to) peer.db.apply(packet.op, 'remote')
//     }
//   }

let enableNetwork = true;
let packets = [];
for (const a of peers) {
  for (const b of peers) {
    if (a !== b) {
      a.db.afterApply(({ op, origin }) => {
        // Always re-render after an operation
        render();

        // Then simulate network delay to propagate to other clients
        if (origin !== "remote") {
          if (enableNetwork) {
            setTimeout(() => {
              for (const peer of peers)
                if (peer.id === b.id) peer.db.apply(op, "remote");
            }, 1000);
          } else {
            packets.push({ op, from: a.id, to: b.id });
            // Render after packets pushed so we can show pending packets
            render();
          }
        }
      });
    }
  }
}

/**
 * TODO list:
 *
 * - Store metadata about inodes
 *    - Dir or File (this is immutable)
 * - Name should not be key
 *    - Should this become metadata?
 */

function drawNode(tree, node) {
  let title = document.createElement("span");
  title.textContent = node.id === "(ROOT)" ? "" : node.id;
  title.style.marginRight = "4px";
  title.style.flexGrow = "1";
  title.style.lineHeight = "21.5px";

  const editBtn = document.createElement("button");
  editBtn.addEventListener("click", () => {
    let inputValue = node.id;
    const input = document.createElement("input");
    input.value = inputValue;
    input.style.width = "100%";

    title.replaceWith(input);

    input.focus();
    input.addEventListener("blur", () => input.replaceWith(title));
    input.addEventListener("input", (e) => {
      inputValue = e.target ? e.target.value : "";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") tree.editChild(node.id, inputValue);
    });
  });
  editBtn.textContent = "e";
  editBtn.style.padding = "0px 4px";
  editBtn.style.marginLeft = "4px";
  editBtn.style.fontSize = "10px";
  if (node.id === "(ROOT)") editBtn.disabled = true;

  const addBtn = document.createElement("button");
  addBtn.addEventListener("click", () => {
    let inputValue: string;
    const input = document.createElement("input");
    input.style.width = "100%";
    const div = document.createElement("div");
    div.style.borderLeft = "1px solid gray";
    div.style.paddingLeft = "16px";
    div.style.display = "flex";
    div.appendChild(input);

    addBtn.parentElement?.parentElement?.append(div);
    input.focus();
    input.addEventListener("blur", () => input.remove());
    input.addEventListener("input", (e) => {
      inputValue = e.target ? e.target.value : "";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") tree.addChildToParent(inputValue, node.id);
    });
  });
  addBtn.textContent = "+";
  addBtn.style.padding = "0px 4px";
  addBtn.style.marginLeft = "4px";
  addBtn.style.fontSize = "10px";

  const rmBtn = document.createElement("button");
  rmBtn.addEventListener("click", () => {
    tree.db.delete(node.id, node.parent.id);
    tree.recomputeParentsAndChildren();
  });
  rmBtn.textContent = "x";
  rmBtn.style.padding = "0px 4px";
  rmBtn.style.marginLeft = "4px";
  rmBtn.style.fontSize = "10px";
  if (node.id === "(ROOT)") rmBtn.disabled = true;

  const inode = document.createElement("div");
  inode.className = "inode";
  inode.style.display = "flex";
  inode.style.paddingTop = "2px";
  inode.style.paddingBottom = "2px";
  inode.append(title, editBtn, addBtn, rmBtn);

  const container = document.createElement("div");
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.paddingLeft = "16px";
  if (node.id !== "(ROOT)") container.style.borderLeft = "1px solid gray";
  container.appendChild(inode);

  if (node.children.length > 0) title.textContent += "/";
  const children = node.children.map((n) => drawNode(tree, n));
  container.append(...children);

  return container;
}

function drawPeer(peer: Peer) {
  const container = document.createElement("div");
  const title = document.createElement("div");
  title.textContent = peer.db._peer;
  title.style.flexGrow = "1";

  const undo = document.createElement("button");
  undo.textContent = "Undo";
  undo.style.marginRight = "4px";
  const redo = document.createElement("button");
  redo.textContent = "Redo";
  undo.addEventListener("click", () => {
    peer.undoRedo.undo();
  });
  redo.addEventListener("click", () => {
    peer.undoRedo.redo();
  });

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.paddingBottom = "4px";
  header.style.marginBottom = "4px";
  header.style.borderBottom = "1px solid gray";
  header.append(title, undo, redo);

  const pendingOps = document.createElement("div");
  pendingOps.style.marginTop = "4px";
  pendingOps.style.paddingTop = "4px";
  pendingOps.style.borderTop = "1px solid gray";
  pendingOps.style.display = "none";
  const pendingOpsTitle = document.createElement("div");
  pendingOpsTitle.textContent = "Pending Ops:";
  pendingOps.append(pendingOpsTitle);
  for (const packet of packets) {
    if (peer.id === packet.from) {
      const pendingOp = document.createElement("div");
      pendingOp.textContent = `ID: ${packet.op.id}\tKey: ${packet.op.key}\tDeleted: ${packet.op.deleted}`;
      pendingOps.append(pendingOp);
      pendingOps.style.display = "block";
    }
  }

  container.append(header);
  container.appendChild(drawNode(peer.tree, peer.tree.root));
  container.append(pendingOps);

  container.style.border = "1px solid black";
  container.style.margin = "8px";
  container.style.padding = "4px";
  container.style.position = "relative";

  const app = document.getElementById("app") as HTMLElement;
  app.appendChild(container);
}

function render() {
  // Clear all elements from previous render
  const app = document.getElementById("app") as HTMLElement;
  while (app.firstChild) {
    app.removeChild(app.firstChild);
  }

  for (const peer of peers) {
    drawPeer(peer);
  }

  const container = document.createElement("div");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = enableNetwork;
  checkbox.addEventListener("change", (e) => {
    // Toggle enableNetwork
    enableNetwork = e.currentTarget.checked ?? false;

    // If re-enabled, flush pending packets
    if (enableNetwork) {
      const toApply = [...packets];
      packets = [];
      for (const packet of toApply) {
        for (const peer of peers)
          if (peer.id === packet.to) peer.db.apply(packet.op, "remote");
      }
      container.style.backgroundColor = "transparent";
    } else {
      container.style.backgroundColor = "#ffcaca";
    }
  });
  const title = document.createElement("span");
  title.textContent = "Network Connection: ";

  container.append(title, checkbox);
  container.style.display = "flex";
  container.style.border = "1px solid black";
  container.style.margin = "8px";
  container.style.padding = "4px";
  app.appendChild(container);
}

function tick() {
  const currentFrame = Date.now();
  const seconds =
    currentFrame - previousFrame < 500
      ? (currentFrame - previousFrame) / 1000
      : 0;
  previousFrame = currentFrame;
  requestAnimationFrame(tick);
  // updateNetworkSim(seconds)
  // for (const peer of peers) peer.updateAnimations(seconds)
  render();
}

function distanceBetween(ax, ay, bx, by) {
  const x = bx - ax;
  const y = by - ay;
  return Math.sqrt(x * x + y * y);
}

render();

//   tick()
// https://madebyevan.com/algos/log-spaced-snapshots/
