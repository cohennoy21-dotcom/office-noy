/**
 * מעקב פניות נוי כהן
 *
 * מדביקים את כל הקובץ הזה בתוך הגיליון:
 * תוספים > Apps Script, מוחקים את הדוגמה, מדביקים, שומרים.
 *
 * לפני הפריסה כותבים קוד גישה בין המרכאות.
 * קוד ארוך, למשל משפט קצר. לא משאירים את זה ריק, ולא משתפים את הקוד.
 * אם משנים את הקוד או את הסקריפט, פורסים שוב גרסה חדשה לאותה פריסה.
 *
 * אפשר גם לשמור את הקוד במאפייני הסקריפט (Script properties)
 * בשם PASSCODE. אם הוא קיים שם, הוא גובר על השורה הזו.
 */
var PASSCODE = "";

var SHEET_NAME = "פניות";
var HEADERS = ["id", "date", "name", "phone", "email", "source", "detail", "service", "followUp", "note", "status", "meeting", "package", "lostReason", "log", "createdAt", "updatedAt"];
var STATUSES = ["חדש", "בתהליך", "נסגר", "לא נסגר"];

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (!params.payload) {
    return json_({
      ok: true,
      service: "noy-leads",
      message: "השירות פעיל. חוזרים לעמוד המעקב ומתחברים משם."
    });
  }
  try {
    return handle_(JSON.parse(params.payload));
  } catch (err) {
    return json_({ ok: false, error: "bad_request" });
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return json_({ ok: false, error: "bad_request" });
    return handle_(JSON.parse(e.postData.contents));
  } catch (err) {
    return json_({ ok: false, error: "bad_request" });
  }
}

function handle_(payload) {
  try {
    if (!payload || typeof payload !== "object") return json_({ ok: false, error: "bad_request" });
    var problem = gate_(payload.passcode);
    if (problem) return json_({ ok: false, error: problem });
    var action = String(payload.action || "");
    return withLock_(function() {
      if (action === "list") return json_({ ok: true, leads: list_() });
      if (action === "create") return json_(create_(payload.lead));
      if (action === "update") return json_(update_(payload.id, payload.patch));
      if (action === "delete") return json_(remove_(payload.id));
      return json_({ ok: false, error: "bad_request" });
    });
  } catch (err) {
    var code = err && (err.message === "bad_sheet" || err.message === "no_sheet") ? err.message : "server";
    return json_({ ok: false, error: code });
  }
}

function expectedPasscode_() {
  var fromProps = "";
  try {
    fromProps = PropertiesService.getScriptProperties().getProperty("PASSCODE") || "";
  } catch (ignore) {
    fromProps = "";
  }
  fromProps = String(fromProps).trim();
  if (fromProps) return fromProps;
  return String(PASSCODE || "").trim();
}

function gate_(given) {
  var expected = expectedPasscode_();
  if (!expected) return "not_configured";
  given = String(given == null ? "" : given).trim();
  if (given.length !== expected.length) return "unauthorized";
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0 ? "" : "unauthorized";
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.TEXT);
}

function fail_(code) {
  throw new Error(code);
}

function activeSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) fail_("no_sheet");
  return ss;
}

function textFormat_(sh) {
  var rows = 1000;
  try {
    if (sh.getMaxRows) rows = Math.max(sh.getMaxRows(), 1);
  } catch (ignore) {}
  sh.getRange(1, 1, rows, HEADERS.length).setNumberFormat("@");
}

function ensureSheet_() {
  var ss = activeSpreadsheet_();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    textFormat_(sh);
    var headerRange = sh.getRange(1, 1, 1, HEADERS.length);
    headerRange.setValues([HEADERS]);
    if (headerRange.setFontWeight) headerRange.setFontWeight("bold");
    sh.setFrozenRows(1);
    return sh;
  }
  textFormat_(sh);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
    return sh;
  }
  var width = Math.max(sh.getLastColumn(), HEADERS.length);
  var header = sh.getRange(1, 1, 1, width).getValues()[0];
  for (var i = 0; i < HEADERS.length; i++) {
    if (cellText_(header[i]).trim() !== HEADERS[i]) fail_("bad_sheet");
  }
  sh.setFrozenRows(1);
  return sh;
}

function cleanStr_(v, max) {
  var s = String(v == null ? "" : v).replace(/\r/g, "").trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime());
}

function cellText_(v) {
  if (v == null || v === "") return "";
  if (isDate_(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  if (typeof v === "number" && isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  var s = String(v);
  if (s.charAt(0) === "'") s = s.slice(1);
  return s;
}

function cleanDate_(v) {
  var s = cleanStr_(cellText_(v), 32);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function readNum_(v) {
  var n = Number(cleanStr_(cellText_(v), 20));
  return isFinite(n) ? n : 0;
}

function readMeeting_(v) {
  if (v === true) return true;
  var s = cleanStr_(cellText_(v), 20);
  return s === "כן" || s === "true" || s === "TRUE" || s === "1";
}

function cleanLog_(v) {
  if (typeof v === "string") {
    if (!v) return [];
    try { v = JSON.parse(v); } catch (ignore) { return []; }
  }
  if (!Array.isArray(v)) return [];
  var out = [];
  for (var i = 0; i < v.length && out.length < 300; i++) {
    var item = v[i] || {};
    var text = cleanStr_(item.text, 2000);
    var t = Number(item.t);
    if (!text || !isFinite(t)) continue;
    out.push({ t: t, text: text });
  }
  while (out.length && JSON.stringify(out).length > 45000) out.shift();
  return out;
}

function readLog_(v) {
  if (Array.isArray(v)) return cleanLog_(v);
  return cleanLog_(cellText_(v).trim());
}

function sheetCell_(v) {
  var s = String(v == null ? "" : v);
  if (!s) return "";
  return "'" + s;
}

function rowToLead_(row) {
  var o = {};
  for (var i = 0; i < HEADERS.length; i++) o[HEADERS[i]] = row[i];
  var status = cleanStr_(cellText_(o.status), 20);
  if (STATUSES.indexOf(status) < 0) status = "חדש";
  return {
    id: cleanStr_(cellText_(o.id), 80),
    date: cleanDate_(o.date),
    name: cleanStr_(cellText_(o.name), 300),
    phone: cleanStr_(cellText_(o.phone), 40),
    email: cleanStr_(cellText_(o.email), 200),
    source: cleanStr_(cellText_(o.source), 80),
    detail: cleanStr_(cellText_(o.detail), 300),
    service: cleanStr_(cellText_(o.service), 80),
    followUp: cleanDate_(o.followUp),
    note: cleanStr_(cellText_(o.note), 5000),
    status: status,
    meeting: readMeeting_(o.meeting),
    package: cleanStr_(cellText_(o.package), 40),
    lostReason: cleanStr_(cellText_(o.lostReason), 40),
    log: readLog_(o.log),
    createdAt: readNum_(o.createdAt),
    updatedAt: readNum_(o.updatedAt)
  };
}

function leadToRow_(l) {
  return [
    sheetCell_(l.id),
    sheetCell_(l.date),
    sheetCell_(l.name),
    sheetCell_(l.phone),
    sheetCell_(l.email),
    sheetCell_(l.source),
    sheetCell_(l.detail),
    sheetCell_(l.service),
    sheetCell_(l.followUp),
    sheetCell_(l.note),
    sheetCell_(l.status),
    sheetCell_(l.meeting ? "כן" : "לא"),
    sheetCell_(l.package),
    sheetCell_(l.lostReason),
    sheetCell_(JSON.stringify(l.log || [])),
    sheetCell_(String(l.createdAt || 0)),
    sheetCell_(String(l.updatedAt || 0))
  ];
}

function publicLead_(l) {
  var o = {};
  for (var i = 0; i < HEADERS.length; i++) o[HEADERS[i]] = l[HEADERS[i]];
  return o;
}

function readRows_() {
  var sh = ensureSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var lead = rowToLead_(values[i]);
    if (!lead.id) continue;
    lead._row = i + 2;
    out.push(lead);
  }
  return out;
}

function list_() {
  var leads = readRows_().map(publicLead_);
  leads.sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  return leads;
}

function validId_(id) {
  return /^[A-Za-z0-9_-]{8,80}$/.test(id);
}

function create_(raw) {
  raw = raw || {};
  var name = cleanStr_(raw.name, 300);
  var date = cleanDate_(raw.date);
  if (!name || !date) return { ok: false, error: "bad_request" };
  var id = cleanStr_(raw.id, 80);
  if (!validId_(id)) id = Utilities.getUuid();
  var rows = readRows_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === id) return { ok: true, id: id, leads: list_() };
  }
  var now = Date.now();
  var status = cleanStr_(raw.status, 20);
  if (STATUSES.indexOf(status) < 0) status = "חדש";
  var lead = {
    id: id,
    date: date,
    name: name,
    phone: cleanStr_(raw.phone, 40),
    email: cleanStr_(raw.email, 200),
    source: cleanStr_(raw.source, 80),
    detail: cleanStr_(raw.detail, 300),
    service: cleanStr_(raw.service, 80),
    followUp: cleanDate_(raw.followUp),
    note: cleanStr_(raw.note, 5000),
    status: status,
    meeting: readMeeting_(raw.meeting),
    package: cleanStr_(raw.package, 40),
    lostReason: cleanStr_(raw.lostReason, 40),
    log: readLog_(raw.log),
    createdAt: readNum_(raw.createdAt) || now,
    updatedAt: now
  };
  ensureSheet_().appendRow(leadToRow_(lead));
  SpreadsheetApp.flush();
  return { ok: true, id: id, leads: list_() };
}

function update_(id, patch) {
  id = cleanStr_(id, 80);
  patch = patch || {};
  if (!validId_(id)) return { ok: false, error: "bad_request" };
  var rows = readRows_();
  var found = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) found = rows[i];
  if (!found) return { ok: false, error: "not_found" };
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    var name = cleanStr_(patch.name, 300);
    if (!name) return { ok: false, error: "bad_request" };
    found.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "date")) {
    var date = cleanDate_(patch.date);
    if (!date) return { ok: false, error: "bad_request" };
    found.date = date;
  }
  var limits = { phone: 40, email: 200, source: 80, detail: 300, service: 80, note: 5000, package: 40, lostReason: 40 };
  Object.keys(limits).forEach(function(key) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
    found[key] = cleanStr_(patch[key], limits[key]);
  });
  if (Object.prototype.hasOwnProperty.call(patch, "followUp")) found.followUp = cleanDate_(patch.followUp);
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    var status = cleanStr_(patch.status, 20);
    if (STATUSES.indexOf(status) >= 0) found.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "meeting")) found.meeting = readMeeting_(patch.meeting);
  if (Object.prototype.hasOwnProperty.call(patch, "log")) found.log = readLog_(patch.log);
  found.updatedAt = Date.now();
  ensureSheet_().getRange(found._row, 1, 1, HEADERS.length).setValues([leadToRow_(found)]);
  SpreadsheetApp.flush();
  return { ok: true, leads: list_() };
}

function remove_(id) {
  id = cleanStr_(id, 80);
  if (!validId_(id)) return { ok: false, error: "bad_request" };
  var rows = readRows_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === id) {
      ensureSheet_().deleteRow(rows[i]._row);
      SpreadsheetApp.flush();
      break;
    }
  }
  return { ok: true, leads: list_() };
}
