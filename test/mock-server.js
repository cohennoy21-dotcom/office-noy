var http = require("http");
var fs = require("fs");
var path = require("path");
var load = require("./load-script");

var ROOT = path.join(__dirname, "..");

function listen(server, port) {
  return new Promise(function(resolve, reject) {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", function() { resolve(server.address().port); });
  });
}

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on("data", function(chunk) { chunks.push(chunk); });
    req.on("end", function() { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

function start(options) {
  var loaded = load.loadAppsScript({ passcode: options.passcode });
  var requests = [];
  var echoes = {};
  var echoPort = options.echoPort;
  var apiPort = options.apiPort;

  function record(entry) { requests.push(entry); return entry; }

  var echo = http.createServer(function(req, res) {
    var url = new URL(req.url, "http://127.0.0.1");
    var entry = record({ host: "echo", method: req.method, path: url.pathname, query: url.search });
    var text = echoes[url.searchParams.get("t")];
    entry.result = text || "";
    if (!text) {
      res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
      res.end("missing");
      return;
    }
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(text);
  });

  var api = http.createServer(async function(req, res) {
    var url = new URL(req.url, "http://127.0.0.1");
    var body = await readBody(req);
    var entry = record({
      host: "api",
      method: req.method,
      path: url.pathname,
      query: url.search,
      headers: req.headers,
      body: body
    });
    if (req.method === "OPTIONS") {
      res.writeHead(405, { Allow: "GET, POST" });
      res.end("no");
      return;
    }
    if (url.pathname !== "/exec") {
      res.writeHead(404);
      res.end();
      return;
    }
    var output;
    if (req.method === "POST") {
      output = loaded.context.doPost({ postData: { type: req.headers["content-type"] || "", contents: body } });
    } else if (req.method === "GET") {
      output = loaded.context.doGet({ parameter: url.searchParams.get("payload") ? { payload: url.searchParams.get("payload") } : {} });
    } else {
      res.writeHead(405);
      res.end();
      return;
    }
    var text = output.getContent();
    entry.result = text;
    var token = Math.random().toString(36).slice(2);
    echoes[token] = text;
    res.writeHead(302, {
      Location: "http://127.0.0.1:" + echoPort + "/echo?t=" + token,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    res.end();
  });

  var page = http.createServer(function(req, res) {
    var url = new URL(req.url, "http://127.0.0.1");
    var rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    var full = path.resolve(ROOT, "." + rel);
    if (full !== ROOT && full.indexOf(ROOT + path.sep) !== 0) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(full, function(err, data) {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      var type = full.endsWith(".html") ? "text/html; charset=utf-8" : full.endsWith(".jpg") ? "image/jpeg" : "text/plain; charset=utf-8";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(data);
    });
  });

  return Promise.all([
    listen(page, options.pagePort),
    listen(api, apiPort),
    listen(echo, echoPort)
  ]).then(function(ports) {
    return {
      loaded: loaded,
      requests: requests,
      pageUrl: "http://127.0.0.1:" + ports[0] + "/",
      apiUrl: "http://127.0.0.1:" + ports[1] + "/exec",
      close: function() {
        page.close();
        api.close();
        echo.close();
      }
    };
  });
}

module.exports = { start: start };
