import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const loadRoomsSource = source.slice(source.indexOf("async function loadRooms("), source.indexOf("let showDeletedRooms="));

function setupCatalog({ configured = true } = {}) {
  let catalog = { rooms: [{ id: "room" }], bots: [{ id: "assistant" }, { id: "designer" }, { id: "reviewer" }] };
  const state = { session: { user: { id: "owner" }, model: { configured, selectable: true } }, selectedRoom: "room", selectedBots: ["designer", "reviewer"] };
  const errors = [];
  const runtime = {
    state, sidebarEpoch: 1, MONITOR_ROOM: "monitor", els: { usage: {} },
    api: async () => catalog,
    renderRooms() {}, voiceUI: { handleLink() {} }, toast: error => errors.push(error),
  };
  vm.runInNewContext(loadRoomsSource + "\nthis.load = loadRooms;", runtime);
  return { state, errors, load: runtime.load, setCatalog: value => { catalog = value; } };
}

test("a selectable model without a configured default keeps the default agent selected", async () => {
  const app = setupCatalog({ configured: false });
  await app.load();
  assert.deepEqual(Array.from(app.state.selectedBots), ["assistant"]);
  assert.deepEqual(app.errors, []);
});

test("catalog refresh discards old role selections and cannot retain a removed bot", async () => {
  const app = setupCatalog();
  await app.load();
  assert.deepEqual(Array.from(app.state.selectedBots), ["assistant"]);
  app.setCatalog({ rooms: [{ id: "room" }], bots: [{ id: "replacement" }, { id: "designer" }] });
  await app.load();
  assert.deepEqual(Array.from(app.state.selectedBots), ["replacement"]);
  app.setCatalog({ rooms: [{ id: "room" }], bots: [] });
  await app.load();
  assert.deepEqual(Array.from(app.state.selectedBots), []);
  assert.deepEqual(app.errors, []);
});
