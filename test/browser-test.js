var fs = require("fs");
var path = require("path");
var mock = require("./mock-server");

var SECRET = "בדיקה-סודי-2026";
var ART = "/opt/cursor/artifacts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function delay(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

async function shot(page, name, fullPage) {
  fs.mkdirSync(ART, { recursive: true });
  await page.screenshot({ path: path.join(ART, name), fullPage: fullPage !== false });
}

async function waitFor(page, fn, msg) {
  var args = Array.prototype.slice.call(arguments, 3);
  try {
    await page.waitForFunction.apply(page, [fn, { timeout: 8000 }].concat(args));
  } catch (err) {
    var state = await page.evaluate(function() {
      return {
        mode: window.mode,
        status: (document.querySelector("#status") || {}).textContent || "",
        setup: (document.querySelector("#setupMsg") || {}).textContent || "",
        form: (document.querySelector("#f-msg") || {}).textContent || "",
        saved: (document.querySelector("#p-saved") || {}).textContent || "",
        leads: window.leads || []
      };
    }).catch(function() { return {}; });
    throw new Error(msg + "\n" + JSON.stringify(state, null, 2));
  }
}

async function setField(page, sel, value) {
  await page.$eval(sel, function(el, v) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, value);
}

async function addLead(page, lead) {
  await page.click("#t-add");
  await waitFor(page, function() { return !document.querySelector("#v-add").hidden; }, "add view");
  await setField(page, "#f-name", lead.name);
  await setField(page, "#f-phone", lead.phone || "");
  await setField(page, "#f-mail", lead.email || "");
  await setField(page, "#f-date", lead.date);
  await setField(page, "#f-src", lead.source);
  await setField(page, "#f-svc", lead.service || "");
  await setField(page, "#f-det", lead.detail || "");
  await setField(page, "#f-fu", lead.followUp || "");
  await setField(page, "#f-note", lead.note || "");
  await page.click("#f-submit");
  await waitFor(page, function(name) {
    return (window.leads || []).some(function(l) { return l.name === name; });
  }, "create " + lead.name, lead.name);
}

async function openLead(page, name) {
  await page.evaluate(function(wanted) {
    var items = Array.prototype.slice.call(document.querySelectorAll(".item"));
    var found = items.find(function(b) { return b.textContent.indexOf(wanted) >= 0; });
    if (!found) throw new Error("no row " + wanted);
    found.click();
  }, name);
  await waitFor(page, function(wanted) {
    var title = document.querySelector("#p-title");
    return title && title.textContent.indexOf(wanted) >= 0;
  }, "open " + name, name);
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  var server = await mock.start({ passcode: SECRET, pagePort: 8765, apiPort: 8766, echoPort: 8767 });
  var puppeteer = require("puppeteer-core");
  var browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=he-IL"]
  });
  var page = await browser.newPage();
  var pageErrors = [];
  var dialogs = [];
  page.on("pageerror", function(err) { pageErrors.push(String(err)); });
  page.on("dialog", function(dialog) { dialogs.push(dialog.message()); return dialog.accept(); });
  page.setDefaultTimeout(8000);
  try {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(server.pageUrl, { waitUntil: "domcontentloaded" });
    await waitFor(page, function() { return window.mode === "setup" && !document.querySelector("#setup").hidden; }, "mobile setup");
    assert(await page.$eval("html", function(el) { return getComputedStyle(el).direction; }) === "rtl", "rtl");
    assert(await page.$eval("#settingsBtn", function(el) { return el.hidden; }), "settings hidden before connect");
    assert(await page.$eval("img", function(img) { return img.complete && img.naturalWidth > 0; }), "logo");
    var setupText = await page.$eval("#setup", function(el) { return el.innerText; });
    assert(setupText.indexOf("לא הסיסמה של גוגל") >= 0, "warns it is not the Google password");
    await shot(page, "connect-mobile.png");
    var mobileOverflow = await page.evaluate(function() { return document.documentElement.scrollWidth - document.documentElement.clientWidth; });
    assert(mobileOverflow <= 1, "mobile setup overflow " + mobileOverflow);

    await page.setViewport({ width: 1200, height: 900 });
    await shot(page, "connect-desktop.png");

    await setField(page, "#cfg-url", "https://example.com/exec");
    await setField(page, "#cfg-pass", "whatever-pass");
    var before = server.requests.length;
    await page.click("#cfg-submit");
    await waitFor(page, function() { return document.querySelector("#setupMsg").textContent.indexOf("/exec") >= 0; }, "bad url message");
    assert(server.requests.length === before, "bad url must not call the sheet");

    await setField(page, "#cfg-url", server.apiUrl);
    await setField(page, "#cfg-pass", "קוד-שגוי");
    await page.click("#cfg-show");
    assert(await page.$eval("#cfg-pass", function(el) { return el.type; }) === "text", "show passcode");
    await page.click("#cfg-submit");
    await waitFor(page, function() { return document.querySelector("#setupMsg").className.indexOf("err") >= 0; }, "wrong passcode error");
    var wrongMsg = await page.$eval("#setupMsg", function(el) { return el.textContent; });
    assert(wrongMsg.indexOf("הקוד לא נכון") >= 0, wrongMsg);
    var wrong = server.requests.filter(function(r) { return r.body && r.body.indexOf("קוד-שגוי") >= 0; });
    assert(wrong.length >= 1, "wrong passcode was sent");
    wrong.forEach(function(r) {
      assert(r.method === "POST", "passcode goes in a POST body");
      assert((r.headers["content-type"] || "").indexOf("text/plain") >= 0, "content type " + r.headers["content-type"]);
      assert(!r.headers.authorization, "no authorization header");
      assert(r.result.indexOf("unauthorized") >= 0, r.result);
      assert(r.result.indexOf("leads") < 0, r.result);
    });
    assert(server.requests.every(function(r) { return r.method !== "OPTIONS"; }), "no preflight");
    assert(!server.loaded.spreadsheet.getSheetByName("פניות"), "wrong passcode must not create the tab");

    await setField(page, "#cfg-pass", SECRET);
    await page.click("#cfg-submit");
    await waitFor(page, function() { return window.mode === "app" && !document.querySelector(".nav").hidden; }, "connected");
    assert(server.requests.some(function(r) { return r.host === "echo" && r.method === "GET"; }), "browser followed the Apps Script redirect");
    assert(!server.requests.some(function(r) { return r.path === "/exec" && r.method === "GET" && r.query.indexOf("payload=") >= 0; }), "list response was readable from the POST redirect");
    assert(await page.evaluate(function() { return window.claude; }) === undefined, "no claude");
    var stored = await page.evaluate(function() { return localStorage.getItem("noy-office-webapp-url"); });
    assert(stored === server.apiUrl, "url stored locally");

    var today = await page.evaluate(function() {
      var d = new Date();
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    });
    var yesterday = await page.evaluate(function() {
      var d = new Date();
      d.setDate(d.getDate() - 1);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    });

    await addLead(page, {
      name: "דנה לוי",
      phone: "052-1234567",
      email: "dana@example.com",
      date: "2026-11-01",
      source: "חבר או מכר",
      service: "ניהול יומן ומיילים",
      detail: "קבוצת מנהלות",
      followUp: today,
      note: "להתקשר אחרי הצהריים"
    });
    await page.click("#t-today");
    await waitFor(page, function() { return document.querySelector("#todList").textContent.indexOf("דנה לוי") >= 0; }, "callback today");
    await shot(page, "today-callback.png");

    await openLead(page, "דנה לוי");
    await page.click("#panel .chk input");
    await waitFor(page, function() { return window.leads.some(function(l) { return l.name === "דנה לוי" && l.meeting; }); }, "meeting");
    await page.evaluate(function() {
      var ta = document.querySelector('#panel textarea[aria-label="מה היה בשיחה"]');
      ta.value = "סיכמנו פגישה";
      var btn = Array.prototype.slice.call(document.querySelectorAll("#panel button")).find(function(b) { return b.textContent === "הוספה ליומן"; });
      btn.click();
    });
    await waitFor(page, function() { return document.querySelector("#panel .log") && document.querySelector("#panel .log").textContent.indexOf("סיכמנו פגישה") >= 0; }, "log");
    await page.evaluate(function() {
      var btn = Array.prototype.slice.call(document.querySelectorAll("#panel .seg button")).find(function(b) { return b.textContent === "נסגר"; });
      btn.click();
    });
    await waitFor(page, function() {
      return Array.prototype.slice.call(document.querySelectorAll("#panel label")).some(function(l) { return l.textContent.indexOf("חבילה") >= 0; });
    }, "package field");
    await page.evaluate(function() {
      var sel = document.querySelector("#panel select");
      sel.value = "שוטפת";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(page, function() {
      return window.leads.some(function(l) { return l.name === "דנה לוי" && l.status === "נסגר" && l.package === "שוטפת"; });
    }, "package saved");
    await page.evaluate(function() {
      var phone = Array.prototype.slice.call(document.querySelectorAll("#panel input")).find(function(i) { return i.type === "tel"; });
      phone.value = "052-9998877";
      phone.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(page, function() { return window.leads.some(function(l) { return l.phone === "052-9998877"; }); }, "phone update");
    await page.keyboard.press("Escape");
    await waitFor(page, function() { return document.querySelector("#sheet").hidden; }, "panel closed");

    await addLead(page, {
      name: "יוסי כהן",
      phone: "054-0001112",
      date: "2026-11-02",
      source: "המלצה",
      service: "הנהלת חשבונות",
      followUp: yesterday,
      note: "יקר לו"
    });
    await page.click("#t-today");
    await waitFor(page, function() { return document.querySelector("#lateList").textContent.indexOf("יוסי כהן") >= 0; }, "late list");
    var badge = await page.$eval("#badge", function(el) { return el.hidden ? "" : el.textContent; });
    assert(badge === "1", "badge " + badge);

    await openLead(page, "יוסי כהן");
    await page.evaluate(function() {
      var btn = Array.prototype.slice.call(document.querySelectorAll("#panel .seg button")).find(function(b) { return b.textContent === "לא נסגר"; });
      btn.click();
    });
    await waitFor(page, function() {
      return Array.prototype.slice.call(document.querySelectorAll("#panel label")).some(function(l) { return l.textContent.indexOf("למה לא נסגר") >= 0; });
    }, "loss field");
    await page.evaluate(function() {
      var sel = Array.prototype.slice.call(document.querySelectorAll("#panel select")).find(function(s) {
        return Array.prototype.slice.call(s.options).some(function(o) { return o.value === "מחיר"; });
      });
      sel.value = "מחיר";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(page, function() {
      return window.leads.some(function(l) { return l.name === "יוסי כהן" && l.lostReason === "מחיר"; });
    }, "loss reason");
    await page.click("#panel .x");

    await page.click("#t-sum");
    await waitFor(page, function() { return !document.querySelector("#v-sum").hidden; }, "summary");
    var tiles = await page.$$eval("#tiles .tile", function(els) { return els.map(function(el) { return el.innerText; }); });
    assert(tiles.some(function(t) { return t.indexOf("פניות") >= 0 && t.indexOf("2") >= 0; }), "inquiry count " + tiles.join(" | "));
    assert(tiles.some(function(t) { return t.indexOf("פגישות היכרות") >= 0 && t.indexOf("1") >= 0; }), "meetings " + tiles.join(" | "));
    assert(tiles.some(function(t) { return t.indexOf("נסגרו") >= 0 && t.indexOf("50%") >= 0; }), "closings " + tiles.join(" | "));
    assert(tiles.some(function(t) { return t.indexOf("הכנסה חודשית") >= 0 && t.replace(/\D/g, "").indexOf("2900") >= 0; }), "mrr " + tiles.join(" | "));
    var summary = await page.$eval("#v-sum", function(el) { return el.innerText; });
    assert(summary.indexOf("חבר או מכר") >= 0, "source");
    assert(summary.indexOf("ניהול יומן ומיילים") >= 0, "service");
    assert(summary.indexOf("שוטפת") >= 0, "package");
    assert(summary.indexOf("מחיר") >= 0, "loss");
    await shot(page, "summary.png");

    await page.click("#t-list");
    await waitFor(page, function() {
      var text = document.querySelector("#leads").innerText;
      var openChip = Array.prototype.slice.call(document.querySelectorAll("#chips button")).find(function(b) { return b.textContent.indexOf("פתוחות") === 0; });
      return text.indexOf("דנה לוי") < 0 && text.indexOf("יוסי כהן") < 0 && openChip && openChip.getAttribute("aria-pressed") === "true" && document.querySelector("#searchHint").hidden;
    }, "default filter hides closed leads");
    var phoneMatch = await page.evaluate(function() {
      function blank(phone) { return { name: "", phone: phone, email: "", note: "", detail: "", service: "" }; }
      var dana = { name: "דנה לוי", phone: "052-9998877", email: "dana@example.com", note: "להתקשר אחרי הצהריים", detail: "קבוצת מנהלות", service: "ניהול יומן ומיילים" };
      return {
        intl: leadMatches(dana, "+972-52-9998877"),
        spaced: leadMatches(dana, "052 999 8877"),
        plain: leadMatches(dana, "0529998877"),
        storedIntl: leadMatches(blank("+972 54-000-1112"), "054-0001112"),
        miss: leadMatches(dana, "0540001112"),
        email: leadMatches(dana, "dana@example.com"),
        note: leadMatches(dana, "אחרי הצהריים")
      };
    });
    assert(phoneMatch.intl && phoneMatch.spaced && phoneMatch.plain && phoneMatch.storedIntl, "phone forms " + JSON.stringify(phoneMatch));
    assert(!phoneMatch.miss && phoneMatch.email && phoneMatch.note, "other fields " + JSON.stringify(phoneMatch));
    await setField(page, "#q", "+972-52-9998877");
    await waitFor(page, function() {
      var text = document.querySelector("#leads").innerText;
      var row = Array.prototype.slice.call(document.querySelectorAll("#leads .item")).find(function(b) { return b.textContent.indexOf("דנה לוי") >= 0; });
      var pill = row && row.querySelector(".pill");
      var hint = document.querySelector("#searchHint");
      var openChip = Array.prototype.slice.call(document.querySelectorAll("#chips button")).find(function(b) { return b.textContent.indexOf("פתוחות") === 0; });
      return text.indexOf("דנה לוי") >= 0 && text.indexOf("יוסי כהן") < 0 && pill && pill.textContent === "נסגר" && pill.className.indexOf("ok") >= 0 && hint && !hint.hidden && hint.textContent.indexOf("מחפשת בכל הפניות, כולל סגורות") >= 0 && openChip.getAttribute("aria-pressed") === "true";
    }, "search finds closed lead under the open filter");
    await page.evaluate(function() { document.querySelector("#searchHint").scrollIntoView({ block: "center" }); });
    await shot(page, "search-includes-closed.png", false);
    await page.evaluate(function() {
      var chip = Array.prototype.slice.call(document.querySelectorAll("#chips button")).find(function(b) { return b.textContent.indexOf("לא נסגר") === 0; });
      chip.click();
    });
    await waitFor(page, function() {
      var text = document.querySelector("#leads").innerText;
      return text.indexOf("דנה לוי") >= 0 && text.indexOf("יוסי כהן") < 0 && !document.querySelector("#searchHint").hidden;
    }, "active search ignores the status filter");
    await page.$eval("#q", function(el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await waitFor(page, function() {
      var text = document.querySelector("#leads").innerText;
      return document.querySelector("#searchHint").hidden && text.indexOf("יוסי כהן") >= 0 && text.indexOf("דנה לוי") < 0 && text.indexOf("לא נסגר") >= 0;
    }, "cleared search restores the lost filter");

    await page.evaluate(function() {
      window.__files = [];
      var orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        if (this.download) window.__files.push({ name: this.download, href: this.href });
        return orig.apply(this, arguments);
      };
    });
    await page.click("#t-sum");
    await page.click("#exportBtn");
    var csv = await page.evaluate(async function() {
      var file = window.__files[0];
      var bytes = new Uint8Array(await (await fetch(file.href)).arrayBuffer());
      var bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
      var text = new TextDecoder().decode(bom ? bytes.subarray(3) : bytes);
      return { name: file.name, text: text, bom: bom };
    });
    assert(csv.name.indexOf(".csv") >= 0, csv.name);
    assert(csv.text.indexOf("דנה לוי") >= 0 && csv.text.indexOf("052-9998877") >= 0, "csv lead");
    assert(csv.text.indexOf("סיכמנו פגישה") >= 0, "csv log");
    assert(csv.bom, "excel bom");

    await setField(page, "#q", "052 999 8877");
    await page.click("#t-list");
    await waitFor(page, function() { return document.querySelector("#leads").innerText.indexOf("דנה לוי") >= 0; }, "spaces in the phone still find the closed lead");
    await openLead(page, "דנה לוי");
    await waitFor(page, function() {
      return Array.prototype.slice.call(document.querySelectorAll("#panel button")).some(function(b) { return b.textContent === "פתיחה מחדש"; });
    }, "reopen button on a won lead");
    await shot(page, "reopen-button.png", false);
    var beforeReopen = await page.evaluate(function() {
      var l = window.leads.filter(function(x) { return x.name === "דנה לוי"; })[0];
      return { log: l.log.map(function(x) { return { t: x.t, text: x.text }; }), email: l.email, phone: l.phone, note: l.note, meeting: l.meeting, service: l.service, source: l.source, detail: l.detail, followUp: l.followUp, date: l.date, package: l.package };
    });
    await page.evaluate(function() {
      Array.prototype.slice.call(document.querySelectorAll("#panel button")).find(function(b) { return b.textContent === "פתיחה מחדש"; }).click();
    });
    await waitFor(page, function() {
      var l = window.leads.filter(function(x) { return x.name === "דנה לוי"; })[0];
      var texts = (l.log || []).map(function(x) { return x.text; });
      return l.status === "בתהליך" && l.package === "" && l.lostReason === "" && texts.indexOf("סיכמנו פגישה") >= 0 && texts.indexOf("הפנייה נפתחה מחדש") >= 0 && texts.length === 2;
    }, "reopen won lead keeps the log");
    var afterReopen = await page.evaluate(function() {
      var l = window.leads.filter(function(x) { return x.name === "דנה לוי"; })[0];
      var prior = (l.log || []).filter(function(x) { return x.text === "סיכמנו פגישה"; })[0];
      return { t: prior && prior.t, email: l.email, phone: l.phone, note: l.note, meeting: l.meeting, service: l.service, source: l.source, detail: l.detail, followUp: l.followUp, date: l.date, statusLabel: document.querySelector("#panel .phead .pill").textContent, button: Array.prototype.slice.call(document.querySelectorAll("#panel button")).some(function(b) { return b.textContent === "פתיחה מחדש"; }), log: document.querySelector("#panel .log").innerText };
    });
    assert(afterReopen.t === beforeReopen.log[0].t, "prior log timestamp kept");
    assert(afterReopen.email === beforeReopen.email && afterReopen.phone === beforeReopen.phone && afterReopen.note === beforeReopen.note, "contact kept");
    assert(afterReopen.meeting === true && afterReopen.service === beforeReopen.service && afterReopen.source === beforeReopen.source && afterReopen.detail === beforeReopen.detail, "details kept");
    assert(afterReopen.followUp === beforeReopen.followUp && afterReopen.date === beforeReopen.date, "dates kept");
    assert(beforeReopen.package === "שוטפת", "package was set before reopen");
    assert(afterReopen.statusLabel === "בתהליך" && !afterReopen.button, "panel shows the reopened status");
    assert(afterReopen.log.indexOf("סיכמנו פגישה") >= 0 && afterReopen.log.indexOf("הפנייה נפתחה מחדש") >= 0, "history visible");
    await page.evaluate(function() { document.querySelector("#panel .log").scrollIntoView({ block: "center" }); });
    await shot(page, "reopen-keeps-history.png", false);
    await page.keyboard.press("Escape");
    await waitFor(page, function() { return document.querySelector("#sheet").hidden; }, "reopen panel closed");

    await page.$eval("#q", function(el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.evaluate(function() {
      var chip = Array.prototype.slice.call(document.querySelectorAll("#chips button")).find(function(b) { return b.textContent.indexOf("לא נסגר") === 0; });
      chip.click();
    });
    await openLead(page, "יוסי כהן");
    await page.evaluate(function() {
      var ta = document.querySelector('#panel textarea[aria-label="מה היה בשיחה"]');
      ta.value = "נשאר ביומן";
      Array.prototype.slice.call(document.querySelectorAll("#panel button")).find(function(b) { return b.textContent === "הוספה ליומן"; }).click();
    });
    await waitFor(page, function() { return document.querySelector("#panel .log") && document.querySelector("#panel .log").textContent.indexOf("נשאר ביומן") >= 0; }, "yossi log");
    await page.evaluate(function() {
      Array.prototype.slice.call(document.querySelectorAll("#panel button")).find(function(b) { return b.textContent === "פתיחה מחדש"; }).click();
    });
    await waitFor(page, function() {
      var l = window.leads.filter(function(x) { return x.name === "יוסי כהן"; })[0];
      var texts = (l.log || []).map(function(x) { return x.text; });
      return l.status === "בתהליך" && l.lostReason === "" && l.package === "" && l.note === "יקר לו" && l.phone === "054-0001112" && texts.indexOf("נשאר ביומן") >= 0 && texts.indexOf("הפנייה נפתחה מחדש") >= 0;
    }, "reopen lost lead clears the reason and keeps the log");
    await page.click("#panel .btn.danger");
    await page.click("#panel .btn.danger");
    await waitFor(page, function() {
      return document.querySelector("#sheet").hidden && !window.leads.some(function(l) { return l.name === "יוסי כהן"; });
    }, "deleted");

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitFor(page, function() {
      return window.mode === "app" && window.leads.some(function(l) {
        var texts = (l.log || []).map(function(x) { return x.text; });
        return l.name === "דנה לוי" && l.status === "בתהליך" && l.package === "" && texts.indexOf("סיכמנו פגישה") >= 0 && texts.indexOf("הפנייה נפתחה מחדש") >= 0;
      }) && !window.leads.some(function(l) { return l.name === "יוסי כהן"; });
    }, "reload keeps the sheet");

    await page.click("#settingsBtn");
    await waitFor(page, function() { return !document.querySelector("#cfg-off").hidden; }, "settings");
    await page.click("#cfg-off");
    await waitFor(page, function() { return document.querySelector("#setupMsg").textContent.indexOf("נותק") >= 0; }, "disconnected");
    assert(dialogs.some(function(m) { return m.indexOf("הפניות נשארות") >= 0; }), "confirm explains data stays");
    var cleared = await page.evaluate(function() {
      return localStorage.getItem("noy-office-webapp-url") || localStorage.getItem("noy-office-passcode");
    });
    assert(!cleared, "local settings cleared");
    assert(await page.$eval(".nav", function(el) { return el.hidden; }), "nav hidden after disconnect");

    await setField(page, "#cfg-url", server.apiUrl);
    await setField(page, "#cfg-pass", SECRET);
    await page.click("#cfg-submit");
    await waitFor(page, function() {
      return window.mode === "app" && window.leads.some(function(l) { return l.name === "דנה לוי"; });
    }, "reconnect still has the lead");

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await delay(100);
    var navBox = await page.$eval(".nav", function(el) {
      var r = el.getBoundingClientRect();
      return { position: getComputedStyle(el).position, bottom: r.bottom, inner: window.innerHeight };
    });
    assert(navBox.position === "fixed", "mobile nav fixed");
    assert(Math.abs(navBox.bottom - navBox.inner) < 3, "mobile nav at the bottom " + JSON.stringify(navBox));
    await shot(page, "today-mobile.png");

    await page.setViewport({ width: 1200, height: 900 });
    await delay(100);
    var desk = await page.$eval(".nav", function(el) { return getComputedStyle(el).position; });
    assert(desk === "sticky", "desktop nav sticky");

    assert(pageErrors.length === 0, "page errors: " + pageErrors.join(" | "));
    var posts = server.requests.filter(function(r) { return r.method === "POST" && r.path === "/exec"; });
    assert(posts.length >= 4, "posts " + posts.length);
    posts.forEach(function(r) {
      assert((r.headers["content-type"] || "").indexOf("text/plain") === 0, r.headers["content-type"]);
      assert(!r.headers.authorization, "header");
    });
    console.log("browser test ok (" + server.requests.length + " requests, " + posts.length + " posts)");
  } catch (err) {
    try { await shot(page, "failure.png"); } catch (ignore) {}
    try {
      var state = await page.evaluate(function() {
        return {
          mode: window.mode,
          status: (document.querySelector("#status") || {}).textContent || "",
          setup: (document.querySelector("#setupMsg") || {}).textContent || "",
          form: (document.querySelector("#f-msg") || {}).textContent || "",
          saved: (document.querySelector("#p-saved") || {}).textContent || "",
          leads: window.leads || [],
          errors: window.__pageErrors || []
        };
      });
      console.error("page state " + JSON.stringify(state, null, 2));
    } catch (ignore2) {}
    console.error("requests " + server.requests.map(function(r) { return r.method + " " + r.host + " " + r.path; }).join(" | "));
    throw err;
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
