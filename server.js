"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, "jds.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------- storage ----------

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

function readAll() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeAll(list) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf8");
}

const uid = () => crypto.randomBytes(6).toString("hex");

// ---------- validation / normalisation ----------

function normalise(input, existing) {
  const now = new Date().toISOString();
  const sections = Array.isArray(input.sections) ? input.sections : [];

  return {
    id: existing ? existing.id : uid(),
    title: String(input.title || "Untitled role").trim(),
    department: String(input.department || "").trim(),
    location: String(input.location || "").trim(),
    employmentType: String(input.employmentType || "").trim(),
    summary: String(input.summary || "").trim(),
    status: input.status === "published" ? "published" : "draft",
    sections: sections.map((s) => ({
      id: s.id || uid(),
      heading: String(s.heading || "").trim(),
      items: (Array.isArray(s.items) ? s.items : [])
        .map((i) => String(i).trim())
        .filter(Boolean),
    })),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
}

// ---------- helpers ----------

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = type.startsWith("application/json")
    ? JSON.stringify(body)
    : body;
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain");

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    send(res, 200, data, MIME[path.extname(filePath)] || "application/octet-stream");
  });
}

// ---------- API ----------

async function handleApi(req, res, pathname) {
  const parts = pathname.replace(/^\/api\/jds\/?/, "").split("/").filter(Boolean);
  const id = parts[0];

  if (req.method === "GET" && !id) return send(res, 200, readAll());

  if (req.method === "GET" && id) {
    const jd = readAll().find((j) => j.id === id);
    return jd ? send(res, 200, jd) : send(res, 404, { error: "Not found" });
  }

  if (req.method === "POST" && !id) {
    const body = await readBody(req);
    const list = readAll();
    const jd = normalise(body, null);
    list.unshift(jd);
    writeAll(list);
    return send(res, 201, jd);
  }

  if (req.method === "PUT" && id) {
    const body = await readBody(req);
    const list = readAll();
    const idx = list.findIndex((j) => j.id === id);
    if (idx === -1) return send(res, 404, { error: "Not found" });
    list[idx] = normalise(body, list[idx]);
    writeAll(list);
    return send(res, 200, list[idx]);
  }

  if (req.method === "DELETE" && id) {
    const list = readAll();
    const next = list.filter((j) => j.id !== id);
    if (next.length === list.length) return send(res, 404, { error: "Not found" });
    writeAll(next);
    return send(res, 200, { ok: true });
  }

  send(res, 405, { error: "Method not allowed" });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(req.url.split("?")[0]);
    if (pathname.startsWith("/api/jds")) return await handleApi(req, res, pathname);
    serveStatic(req, res);
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

function createServer() {
  return server;
}

module.exports = { createServer, normalise, readAll, writeAll, ensureStore };

if (require.main === module) {
  ensureStore();
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    console.log(`JD Manager running at http://${HOST}:${addr.port}`);
  });
}
