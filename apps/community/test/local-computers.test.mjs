import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createLocalComputers, LOCAL_COMPUTER_TOOLS, LOCAL_COMPUTER_PROMPT } from "../local-computers.mjs";

const OWNER = "owner", OTHER = "other-owner", ROOM = "private-room", OTHER_ROOM = "other-private-room";
const details = { name: "My computer", platform: "darwin", capabilities: ["fs", "terminal", "browser"] };
function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  const access = new Map([[OWNER, new Set([ROOM])], [OTHER, new Set([OTHER_ROOM])]]);
  const owners = new Set([OWNER, OTHER]);
  let time = 100000;
  const settings = { db, authorize: (owner, room) => access.get(owner)?.has(room) === true, authorizeOwner: owner => owners.has(owner), now: () => time, ...options };
  let hub = createLocalComputers(settings);
  t.after(() => { hub.close(); db.close(); });
  return { db, access, owners, get hub() { return hub; }, advance: ms => { time += ms; }, restart() { hub.close(); hub = createLocalComputers(settings); }, register: (owner = OWNER, value = details) => hub.register({ id: owner }, value) };
}
const context = (userId = OWNER, roomId = ROOM) => ({ userId, roomId });
const outcome = promise => promise.then(result => ({ result }), error => ({ error }));
const errorCode = code => error => error.code === code;

test("desktop tokens persist only as hashes and never appear in device responses", t => {
  const f = fixture(t);
  const registered = f.register();
  assert.match(registered.token, /^ccb_pc_[A-Za-z0-9_-]{43}$/);
  const stored = f.db.prepare("SELECT * FROM local_computers").get();
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(registered.token));
  assert.ok(!JSON.stringify(registered.device).includes(stored.token_hash));
  assert.equal(f.hub.authenticate(registered.token).userId, OWNER);
  assert.equal(f.hub.configured(OWNER, ROOM), true);
  f.restart();
  assert.equal(f.hub.authenticate(registered.token).id, registered.device.id);
  assert.equal(f.hub.configured(OWNER, ROOM), false, "restart requires a fresh companion poll");
  assert.equal(f.hub.poll(registered.token).job, null);
  assert.equal(f.hub.configured(OWNER, ROOM), true);
  assert.throws(() => f.hub.authenticate(registered.token.slice(0, -1) + "!"), errorCode("LOCAL_COMPUTER_UNAUTHORIZED"));
});

test("owners cannot list, select, revoke, enqueue or complete work for another owner", async t => {
  const f = fixture(t), first = f.register(), second = f.register(OTHER);
  assert.deepEqual(f.hub.list(OWNER).map(device => device.id), [first.device.id]);
  assert.throws(() => f.hub.select(OTHER, first.device.id), errorCode("LOCAL_COMPUTER_NOT_FOUND"));
  assert.throws(() => f.hub.revoke(OTHER, first.device.id), errorCode("LOCAL_COMPUTER_NOT_FOUND"));
  assert.equal(f.hub.configured(OTHER, ROOM), false);
  await assert.rejects(f.hub.execute(context(OTHER), "computer_status", {}), errorCode("LOCAL_COMPUTER_FORBIDDEN"));
  const result = f.hub.execute(context(), "computer_exec", { command: "pwd" });
  const { job } = f.hub.poll(first.token);
  assert.equal(f.hub.poll(second.token).job, null);
  assert.throws(() => f.hub.complete(second.token, job.id, { ok: true, result: "wrong owner" }), errorCode("LOCAL_COMPUTER_JOB_NOT_FOUND"));
  f.hub.complete(first.token, job.id, { ok: true, result: "my folder" });
  assert.equal(await result, "my folder");
});

test("a dispatched command is never delivered twice and completion cannot be replayed", async t => {
  const f = fixture(t), { token } = f.register();
  const first = f.hub.execute(context(), "computer_exec", { command: "printf first" });
  const second = f.hub.execute(context(), "computer_exec", { command: "printf second" });
  const job = f.hub.poll(token).job;
  assert.equal(job.tool, "computer_exec");
  assert.equal(job.roomId, ROOM);
  assert.equal(job.args.command, "printf first");
  for (let count = 0; count < 4; count++) assert.equal(f.hub.poll(token).job, null, "lost poll never redelivers the command");
  f.hub.complete(token, job.id, { ok: true, result: { stdout: "first" } });
  assert.deepEqual(await first, { stdout: "first" });
  assert.throws(() => f.hub.complete(token, job.id, { ok: true, result: "replay" }), errorCode("LOCAL_COMPUTER_JOB_FINISHED"));
  const next = f.hub.poll(token).job;
  assert.notEqual(next.id, job.id);
  assert.equal(next.args.command, "printf second");
  f.hub.complete(token, next.id, { ok: false, error: "Local terminal permission was disabled" });
  await assert.rejects(second, error => error.code === "LOCAL_COMPUTER_FAILED" && error.message.includes("permission"));
});

test("revocation immediately rejects in-flight and queued work and invalidates the token", async t => {
  const f = fixture(t), { device, token } = f.register();
  const pending = outcome(f.hub.execute(context(), "computer_exec", { command: "echo example" }));
  const queued = outcome(f.hub.execute(context(), "computer_status", {}));
  f.hub.poll(token);
  f.hub.revoke(OWNER, device.id);
  assert.equal((await pending).error.code, "LOCAL_COMPUTER_REVOKED");
  assert.equal((await queued).error.code, "LOCAL_COMPUTER_REVOKED");
  assert.throws(() => f.hub.poll(token), errorCode("LOCAL_COMPUTER_UNAUTHORIZED"));
  assert.equal(f.hub.configured(OWNER, ROOM), false);
  assert.deepEqual(f.hub.list(OWNER), []);
});

test("pause cancels active and queued work immediately without invalidating its credential", async t => {
  const f = fixture(t), { token, device } = f.register();
  const active = outcome(f.hub.execute(context(), "computer_exec", { command: "echo pause" }));
  const queued = outcome(f.hub.execute(context(), "computer_status", {}));
  const job = f.hub.poll(token).job;
  const response = f.hub.pause(token);
  assert.equal(response.ok, true);
  assert.equal(response.device.online, false);
  assert.equal((await active).error.code, "LOCAL_COMPUTER_PAUSED");
  assert.equal((await queued).error.code, "LOCAL_COMPUTER_PAUSED");
  assert.equal(f.hub.configured(OWNER, ROOM), false);
  assert.deepEqual(f.hub.toolsFor(OWNER, ROOM), []);
  assert.equal(f.hub.authenticate(token).id, device.id);
  assert.equal(f.hub.authenticate(token).online, false, "authenticating alone must not resume a paused computer");
  await assert.rejects(f.hub.execute(context(), "computer_status", {}), errorCode("LOCAL_COMPUTER_OFFLINE"));
  const resumed = f.hub.poll(token);
  assert.equal(resumed.job, null);
  assert.deepEqual(resumed.cancellations, [job.id]);
  assert.equal(f.hub.configured(OWNER, ROOM), true, "a native poll resumes the same credential");
  assert.throws(() => f.hub.complete(token, job.id, { ok: false, error: "Stopped" }), errorCode("LOCAL_COMPUTER_JOB_FINISHED"));
  assert.deepEqual(f.hub.poll(token).cancellations, []);
});

test("a cancelled active job blocks new dispatch until its stop acknowledgment, even after its old deadline", async t => {
  const f = fixture(t), { token } = f.register();
  const controller = new AbortController();
  const active = outcome(f.hub.execute(context(), "computer_exec", { command: "echo first" }, { signal: controller.signal }));
  const original = f.hub.poll(token).job;
  controller.abort();
  assert.equal((await active).error.code, "LOCAL_COMPUTER_CANCELLED");
  f.advance(120000);
  assert.deepEqual(f.hub.poll(token).cancellations, [original.id], "cancellation survives the recent-result retention window");
  const queued = f.hub.execute(context(), "computer_exec", { command: "echo second" });
  for (let count = 0; count < 3; count++) {
    const poll = f.hub.poll(token);
    assert.equal(poll.job, null, "a second process cannot overtake a cancelled one");
    assert.deepEqual(poll.cancellations, [original.id]);
  }
  // A companion that never received the first response acknowledges this same
  // ID without executing it. The next command becomes deliverable only then.
  assert.throws(() => f.hub.complete(token, original.id, { ok: false, error: "Cancelled before execution" }), errorCode("LOCAL_COMPUTER_JOB_FINISHED"));
  const next = f.hub.poll(token);
  assert.deepEqual(next.cancellations, []);
  assert.equal(next.job.args.command, "echo second");
  f.hub.complete(token, next.job.id, { ok: true, result: "second" });
  assert.equal(await queued, "second");
});

test("changed room access cancels queued or dispatched work before delivery or acceptance", async t => {
  for (const at of ["queued", "dispatched", "complete"]) {
    const f = fixture(t), { token } = f.register();
    const pending = outcome(f.hub.execute(context(), "computer_read_file", { path: "/allowed/example.txt" }));
    const job = at !== "queued" ? f.hub.poll(token).job : null;
    f.access.get(OWNER).delete(ROOM);
    assert.equal(f.hub.configured(OWNER, ROOM), false);
    if (at === "complete") assert.throws(() => f.hub.complete(token, job.id, { ok: true, result: "private contents" }), errorCode("LOCAL_COMPUTER_FORBIDDEN"));
    else {
      const response = f.hub.poll(token);
      assert.equal(response.job, null);
      assert.deepEqual(response.cancellations, job ? [job.id] : []);
    }
    assert.equal((await pending).error.code, "LOCAL_COMPUTER_FORBIDDEN");
  }
});

test("owner account expiry denies polling and cancels its running job", async t => {
  const f = fixture(t), { token } = f.register();
  const pending = outcome(f.hub.execute(context(), "computer_status", {}));
  f.hub.poll(token);
  f.owners.delete(OWNER);
  assert.throws(() => f.hub.poll(token), errorCode("LOCAL_COMPUTER_UNAUTHORIZED"));
  assert.equal((await pending).error.code, "LOCAL_COMPUTER_FORBIDDEN");
  assert.equal(f.hub.configured(OWNER, ROOM), false);
});

test("offline computers are not advertised; polls renew their online status", async t => {
  const f = fixture(t, { onlineMs: 100 }), { token } = f.register();
  f.advance(101);
  assert.equal(f.hub.list(OWNER)[0].online, false);
  assert.equal(f.hub.configured(OWNER, ROOM), false);
  await assert.rejects(f.hub.execute(context(), "computer_status", {}), errorCode("LOCAL_COMPUTER_OFFLINE"));
  f.hub.poll(token);
  assert.equal(f.hub.configured(OWNER, ROOM), true);
});

test("deadline and cancellation never retry work and notify the native companion", async t => {
  const f = fixture(t, { jobTimeoutMs: 100 }), { token } = f.register();
  const timedOut = outcome(f.hub.execute(context(), "computer_exec", { command: "echo once" }));
  const job = f.hub.poll(token).job;
  f.advance(101);
  const expired = f.hub.poll(token);
  assert.equal(expired.job, null);
  assert.deepEqual(expired.cancellations, [job.id]);
  assert.equal((await timedOut).error.code, "LOCAL_COMPUTER_TIMEOUT");
  assert.throws(() => f.hub.complete(token, job.id, { ok: true, result: "late" }), errorCode("LOCAL_COMPUTER_JOB_FINISHED"));
  assert.deepEqual(f.hub.poll(token).cancellations, []);

  const controller = new AbortController();
  const aborted = outcome(f.hub.execute(context(), "computer_exec", { command: "echo stop" }, { signal: controller.signal }));
  const active = f.hub.poll(token).job;
  controller.abort();
  assert.equal((await aborted).error.code, "LOCAL_COMPUTER_CANCELLED");
  assert.deepEqual(f.hub.poll(token).cancellations, [active.id]);
  assert.deepEqual(f.hub.poll(token).cancellations, [active.id], "a dropped cancellation response is safe to repeat");
  await assert.rejects(f.hub.execute(context(), "computer_status", {}, { signal: controller.signal }), errorCode("LOCAL_COMPUTER_CANCELLED"));
});

test("real timer expires an unanswered request without requiring another poll", async t => {
  const f = fixture(t, { jobTimeoutMs: 10 }), { token } = f.register();
  const pending = outcome(f.hub.execute(context(), "computer_status", {}));
  const job = f.hub.poll(token).job;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await pending).error.code, "LOCAL_COMPUTER_TIMEOUT");
  assert.deepEqual(f.hub.poll(token).cancellations, [job.id]);
});

test("selection is explicit and changing computers cancels old work", async t => {
  const f = fixture(t), first = f.register();
  const pending = outcome(f.hub.execute(context(), "computer_status", {}));
  const job = f.hub.poll(first.token).job;
  const second = f.register(OWNER, { ...details, name: "Second computer" });
  assert.equal((await pending).error.code, "LOCAL_COMPUTER_CHANGED");
  assert.deepEqual(f.hub.poll(first.token).cancellations, [job.id]);
  assert.equal(f.hub.list(OWNER).filter(device => device.selected).length, 1);
  const current = f.hub.execute(context(), "computer_status", {});
  const next = f.hub.poll(second.token).job;
  f.hub.complete(second.token, next.id, { ok: true, result: { name: "Second computer" } });
  assert.equal((await current).name, "Second computer");
  assert.equal(f.hub.select(OWNER, first.device.id).selected, true);
});

test("capabilities restrict advertised tools and independently gate enqueue", async t => {
  const f = fixture(t);
  f.register(OWNER, { ...details, capabilities: ["fs"] });
  const names = f.hub.toolsFor(OWNER, ROOM).map(tool => tool.function.name);
  assert.deepEqual(names, ["computer_status", "computer_list_files", "computer_read_file", "computer_write_file"]);
  await assert.rejects(f.hub.execute(context(), "computer_exec", { command: "pwd" }), errorCode("LOCAL_COMPUTER_PERMISSION_DISABLED"));
  await assert.rejects(f.hub.execute(context(), "computer_open_url", { url: "https://example.com" }), errorCode("LOCAL_COMPUTER_PERMISSION_DISABLED"));
  assert.deepEqual(f.hub.toolsFor(OTHER, ROOM), []);
});

test("tool inputs do not allow choosing another owner, device or room", async t => {
  const f = fixture(t); f.register();
  for (const [name, args] of [
    ["computer_status", { roomId: OTHER_ROOM }], ["computer_exec", { command: "pwd", deviceId: "other" }],
    ["computer_read_file", { path: "/tmp/x\0" }], ["computer_write_file", { path: "/tmp/x", content: 10 }],
    ["computer_open_url", { url: "file:///tmp/x" }], ["computer_open_url", { url: "https://user:secret@example.com" }],
    ["computer_exec", { command: "" }], ["computer_status", []],
  ]) await assert.rejects(f.hub.execute(context(), name, args), errorCode("LOCAL_COMPUTER_INPUT_INVALID"));
  await assert.rejects(f.hub.execute(context(), "computer_delete_everything", {}), errorCode("LOCAL_COMPUTER_TOOL_INVALID"));
  for (const { function: tool } of LOCAL_COMPUTER_TOOLS) assert.equal(tool.parameters.additionalProperties, false);
  assert.match(LOCAL_COMPUTER_PROMPT, /NOT OCI/);
  assert.match(LOCAL_COMPUTER_PROMPT, /untrusted/);
  assert.match(LOCAL_COMPUTER_PROMPT, /do not retry/i);
});

test("queue and output limits fail closed without stranding a request", async t => {
  const f = fixture(t, { maxPending: 1, maxResultBytes: 100 }), { token } = f.register();
  const pending = outcome(f.hub.execute(context(), "computer_status", {}));
  await assert.rejects(f.hub.execute(context(), "computer_status", {}), errorCode("LOCAL_COMPUTER_BUSY"));
  const job = f.hub.poll(token).job;
  assert.throws(() => f.hub.complete(token, job.id, { ok: true, result: "x".repeat(101) }), errorCode("LOCAL_COMPUTER_RESULT_TOO_LARGE"));
  assert.equal((await pending).error.code, "LOCAL_COMPUTER_RESULT_TOO_LARGE");
  assert.equal(f.hub.poll(token).job, null);
});

test("restart abandons pending work instead of persisting or replaying commands", async t => {
  const f = fixture(t), { token } = f.register();
  const pending = outcome(f.hub.execute(context(), "computer_exec", { command: "echo never-repeat" }));
  f.hub.poll(token);
  f.restart();
  assert.equal((await pending).error.code, "LOCAL_COMPUTER_CLOSED");
  assert.equal(f.hub.poll(token).job, null);
  assert.equal(f.hub.authenticate(token).userId, OWNER);
});

test("asynchronous authorization is rejected rather than treated as a truthy permission", async t => {
  const f = fixture(t, { authorize: async () => true }); f.register();
  assert.equal(f.hub.configured(OWNER, ROOM), false);
  await assert.rejects(f.hub.execute(context(), "computer_status", {}), errorCode("LOCAL_COMPUTER_FORBIDDEN"));
});
