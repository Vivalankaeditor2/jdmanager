"use strict";

// Point the app at a throwaway data file BEFORE loading it, so tests never
// touch the real data/jds.json.
const os = require("os");
const fs = require("fs");
const path = require("path");
const http = require("http");

const TMP_DATA = path.join(os.tmpdir(), `jd-test-${process.pid}-${Date.now()}.json`);
process.env.DATA_FILE = TMP_DATA;

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const server = require("../server.js").createServer();
let base;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      base + urlPath,
      {
        method,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json;
          try { json = JSON.parse(raw); } catch { json = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, text: raw, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  try { fs.unlinkSync(TMP_DATA); } catch {}
});

test("GET /api/jds starts empty", async () => {
  const res = await request("GET", "/api/jds");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, []);
});

test("POST /api/jds creates a JD with sane defaults", async () => {
  const res = await request("POST", "/api/jds", { title: "QA Engineer", sections: [] });
  assert.equal(res.status, 201);
  assert.ok(res.json.id, "gets an id");
  assert.equal(res.json.title, "QA Engineer");
  assert.equal(res.json.status, "draft", "status defaults to draft");
  assert.ok(res.json.createdAt && res.json.updatedAt);
});

test("POST trims fields and drops empty bullet items", async () => {
  const res = await request("POST", "/api/jds", {
    title: "  Padded  ",
    status: "bogus",
    sections: [{ heading: "  Duties ", items: [" do stuff ", "", "   "] }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.title, "Padded");
  assert.equal(res.json.status, "draft", "unknown status falls back to draft");
  assert.deepEqual(res.json.sections[0].items, ["do stuff"]);
});

test("GET /api/jds/:id returns the JD; unknown id is 404", async () => {
  const created = (await request("POST", "/api/jds", { title: "Designer" })).json;
  const found = await request("GET", `/api/jds/${created.id}`);
  assert.equal(found.status, 200);
  assert.equal(found.json.title, "Designer");

  const missing = await request("GET", "/api/jds/does-not-exist");
  assert.equal(missing.status, 404);
});

test("PUT updates in place and bumps updatedAt", async () => {
  const created = (await request("POST", "/api/jds", { title: "Before" })).json;
  await new Promise((r) => setTimeout(r, 5));

  const updated = await request("PUT", `/api/jds/${created.id}`, { title: "After", status: "published" });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.id, created.id, "id is stable");
  assert.equal(updated.json.title, "After");
  assert.equal(updated.json.status, "published");
  assert.equal(updated.json.createdAt, created.createdAt, "createdAt preserved");
  assert.notEqual(updated.json.updatedAt, created.updatedAt, "updatedAt changed");

  const missing = await request("PUT", "/api/jds/nope", { title: "x" });
  assert.equal(missing.status, 404);
});

test("DELETE removes the JD; second delete is 404", async () => {
  const created = (await request("POST", "/api/jds", { title: "Temp" })).json;
  const del = await request("DELETE", `/api/jds/${created.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.json, { ok: true });

  assert.equal((await request("GET", `/api/jds/${created.id}`)).status, 404);
  assert.equal((await request("DELETE", `/api/jds/${created.id}`)).status, 404);
});

test("invalid JSON body yields 400", async () => {
  const res = await new Promise((resolve, reject) => {
    const req = http.request(base + "/api/jds", { method: "POST" }, (r) => {
      let raw = "";
      r.on("data", (c) => (raw += c));
      r.on("end", () => resolve({ status: r.statusCode, text: raw }));
    });
    req.on("error", reject);
    req.write("{not json");
    req.end();
  });
  assert.equal(res.status, 400);
});

test("unsupported method on collection is 405", async () => {
  const res = await request("PATCH", "/api/jds");
  assert.equal(res.status, 405);
});

test("static index.html is served with the app marker and highlight CSS", async () => {
  const index = await request("GET", "/");
  assert.equal(index.status, 200);
  assert.match(index.headers["content-type"], /text\/html/);
  assert.match(index.text, /JD Manager/);

  const css = await request("GET", "/styles.css");
  assert.equal(css.status, 200);
  assert.match(css.text, /#editorForm\s*>\s*label:nth-child\(4\)\s*>\s*select/, "highlight rule is present");
});

test("missing static file is 404 and traversal is blocked", async () => {
  assert.equal((await request("GET", "/nope.js")).status, 404);
  const traversal = await request("GET", "/../server.js");
  assert.ok([403, 404].includes(traversal.status), `traversal blocked, got ${traversal.status}`);
});
