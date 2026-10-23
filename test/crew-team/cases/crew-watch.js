"use strict";
// /crew's watcher on the main chat, over --stdio (it looks every 0.7 s here instead of every 20 s)
const assert = require("assert");
const { suite, T, session, command, until, sleep } = require("../lib/harness");

const ENV = { YAI_CREW_WATCH_MS: "700" };
const research = (r) => (r.turn === 0 ? T("write_file", { path: "RESEARCH.md", content: "x" }) : "Researched.");
const STOP = "Stop checking the page; change js/game.js now.";

// the main chat makes `steps` (one a reply, slowly enough for the watcher to look), then finishes
function mainWith(steps, { watcher } = {}) {
  return async (r) => {
    if (r.who === "researcher") return research(r);
    if (r.who === "watcher") return watcher ? watcher(r) : JSON.stringify({ actions: [{ agent: "main", message: STOP, block: ["page_eval"], steps: 4 }] });
    if (r.who === "main") {
      await sleep(450);
      if (/INSTRUCTION FROM yAI/.test(r.text) && !/Following the watcher/.test(r.text) && r.turn < steps.length + 2) return "Following the watcher: changing the code.\n" + T("write_file", { path: "js/game.js", content: "window.G = 1;" });
      return r.turn < steps.length ? (r.turn === 0 ? "<plan>\n1. a\n</plan>\n" : "") + steps[r.turn] : "Done.";
    }
    return "Done.";
  };
}

suite(__filename, [
  { name: "page checks with different code aren't 'the same step': the watcher isn't asked", ms: 60000, fn: async (ctl) => {
    const steps = ["document.title", "window.G", "document.querySelectorAll('canvas').length", "innerWidth", "innerHeight"].map((code) => T("page_eval", { code }));
    const { y, srv } = await session(ctl, mainWith(steps), { env: ENV });
    await command(y, "/crew check the page", { mode: "acceptEdits" });
    assert.strictEqual(srv.of("watcher").length, 0);
  } },
  { name: "the same page check again and again: the watcher is asked, and its instruction reaches the chat", ms: 60000, fn: async (ctl) => {
    const steps = Array.from({ length: 6 }, () => T("page_eval", { code: "document.title" }));
    const { y, srv } = await session(ctl, mainWith(steps), { env: ENV });
    await command(y, "/crew check the page", { mode: "acceptEdits" });
    const w = srv.of("watcher");
    assert.ok(w.length >= 1, "the watcher was asked");
    assert.match(w[0].text, /## main \(the session itself\)/);
    assert.match(w[0].text, /the same step \d+ times/);
    assert.ok(srv.of("main").some((r) => /INSTRUCTION FROM yAI/.test(r.text) && r.text.includes(STOP)), "the instruction reached the chat");
    assert.ok(!srv.of("main").some((r) => /Blocked for your next/.test(r.text)), "the first instruction blocks nothing");
    assert.ok(y.notes().some((n) => /The watcher:/.test(n)));
  } },
  { name: "a second instruction for the same loop blocks the repeated tool, even when the watcher named no block", ms: 90000, fn: async (ctl) => {
    const pad = "/* " + "the same long probe of the world and the player, ".repeat(4) + " */ ";
    const steps = Array.from({ length: 40 }, (_, i) => T("page_eval", { code: `${pad}Game.world.n + ${i}` }));
    const { y, srv } = await session(ctl, mainWith(steps, { watcher: () => JSON.stringify({ actions: [{ agent: "main", message: STOP }] }) }), { env: { ...ENV, YAI_CREW_COOLDOWN_MS: "1500" } });
    await command(y, "/crew check the page", { mode: "acceptEdits", ms: 80000 });
    const banners = srv.of("main").filter((r) => /INSTRUCTION FROM yAI/.test(r.messages[r.messages.length - 1].content));
    assert.ok(banners.length >= 2, `${banners.length} instructions`);
    assert.ok(!/Blocked for your next/.test(banners[0].messages.slice(-1)[0].content), "the first blocks nothing");
    assert.ok(banners.slice(1).some((r) => /Blocked for your next \d+ steps: no page_eval/.test(r.messages.slice(-1)[0].content)), "a later one blocks page_eval");
  } },
  { name: "a watcher that answers nonsense changes nothing and breaks nothing", ms: 60000, fn: async (ctl) => {
    const steps = Array.from({ length: 6 }, () => T("page_eval", { code: "document.title" }));
    const { y, srv } = await session(ctl, mainWith(steps, { watcher: () => "I think it's fine, no JSON here {broken" }), { env: ENV });
    await command(y, "/crew check the page", { mode: "acceptEdits" });
    assert.ok(srv.of("watcher").length >= 1);
    assert.ok(!srv.of("main").some((r) => /INSTRUCTION FROM yAI/.test(r.text)));
  } },
  { name: "a watcher whose request fails changes nothing and breaks nothing", ms: 60000, fn: async (ctl) => {
    const steps = Array.from({ length: 6 }, () => T("page_eval", { code: "document.title" }));
    const { y, srv } = await session(ctl, mainWith(steps, { watcher: () => ({ status: 500, error: "watcher down" }) }), { env: ENV });
    await command(y, "/crew check the page", { mode: "acceptEdits" });
    assert.ok(srv.of("watcher").length >= 1);
    assert.ok(srv.of("main").length >= 7, "the chat went on to the end");
  } },
  { name: "the watcher's instruction for an agent it wasn't shown is ignored", ms: 60000, fn: async (ctl) => {
    const steps = Array.from({ length: 6 }, () => T("page_eval", { code: "document.title" }));
    const { y, srv } = await session(ctl, mainWith(steps, { watcher: () => JSON.stringify({ actions: [{ agent: "ghost", message: "Do something." }] }) }), { env: ENV });
    await command(y, "/crew check the page", { mode: "acceptEdits" });
    assert.ok(!srv.of("main").some((r) => /INSTRUCTION FROM yAI/.test(r.text)));
  } },
]);
