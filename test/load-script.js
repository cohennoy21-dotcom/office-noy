var fs = require("fs");
var path = require("path");
var vm = require("vm");

function createMemorySpreadsheet() {
  var sheets = {};
  return {
    getSheetByName: function(name) { return sheets[name] || null; },
    insertSheet: function(name) {
      var rows = [];
      var sheet = {
        getLastRow: function() {
          var last = 0;
          for (var i = 0; i < rows.length; i++) {
            var line = rows[i];
            if (!line) continue;
            for (var c = 0; c < line.length; c++) {
              if (line[c] !== "" && line[c] != null) { last = i + 1; break; }
            }
          }
          return last;
        },
        getLastColumn: function() {
          var last = 0;
          rows.forEach(function(line) {
            if (!line) return;
            for (var c = 0; c < line.length; c++) {
              if (line[c] !== "" && line[c] != null) last = Math.max(last, c + 1);
            }
          });
          return last;
        },
        getMaxRows: function() { return 1000; },
        getRange: function(row, col, numRows, numCols) {
          return {
            getValues: function() {
              var out = [];
              for (var r = 0; r < numRows; r++) {
                var line = [];
                var src = rows[row - 1 + r] || [];
                for (var c = 0; c < numCols; c++) {
                  var value = src[col - 1 + c];
                  line.push(value == null ? "" : value);
                }
                out.push(line);
              }
              return out;
            },
            setValues: function(values) {
              for (var r = 0; r < values.length; r++) {
                if (!rows[row - 1 + r]) rows[row - 1 + r] = [];
                for (var c = 0; c < values[r].length; c++) rows[row - 1 + r][col - 1 + c] = values[r][c];
              }
            },
            setNumberFormat: function() { return this; },
            setFontWeight: function() { return this; }
          };
        },
        appendRow: function(arr) { rows.push(arr.slice()); },
        deleteRow: function(row) { rows.splice(row - 1, 1); },
        setFrozenRows: function() {},
        _rows: rows
      };
      sheets[name] = sheet;
      return sheet;
    },
    _sheets: sheets
  };
}

function loadAppsScript(options) {
  options = options || {};
  var spreadsheet = options.spreadsheet || createMemorySpreadsheet();
  var properties = Object.assign({}, options.properties || {});
  var uuidN = 0;
  var context = {
    SpreadsheetApp: {
      getActiveSpreadsheet: function() { return spreadsheet; },
      flush: function() {}
    },
    PropertiesService: {
      getScriptProperties: function() {
        return {
          getProperty: function(key) { return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null; },
          setProperty: function(key, value) { properties[key] = value; }
        };
      }
    },
    LockService: {
      getScriptLock: function() {
        return { waitLock: function() {}, releaseLock: function() {} };
      }
    },
    Utilities: {
      getUuid: function() {
        uuidN += 1;
        return "aaaaaaaa-bbbb-4ccc-8ddd-" + String(uuidN).padStart(12, "0");
      },
      formatDate: function(date, tz) {
        var parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz || "Asia/Jerusalem",
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).format(date);
        return parts;
      }
    },
    Session: {
      getScriptTimeZone: function() { return "Asia/Jerusalem"; }
    },
    ContentService: {
      MimeType: { TEXT: "text/plain", JSON: "application/json" },
      createTextOutput: function(text) {
        return {
          mime: null,
          setMimeType: function(mime) { this.mime = mime; return this; },
          getContent: function() { return text; }
        };
      }
    },
    console: console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8"), context, { filename: "Code.gs" });
  if (options.passcode != null) context.PASSCODE = options.passcode;
  return { context: context, spreadsheet: spreadsheet, properties: properties };
}

function callScript(loaded, payload, method) {
  var event = method === "get"
    ? { parameter: { payload: JSON.stringify(payload) } }
    : { postData: { type: "text/plain", contents: JSON.stringify(payload) } };
  var output = method === "get" ? loaded.context.doGet(event) : loaded.context.doPost(event);
  return { body: JSON.parse(output.getContent()), mime: output.mime, raw: output.getContent() };
}

module.exports = {
  createMemorySpreadsheet: createMemorySpreadsheet,
  loadAppsScript: loadAppsScript,
  callScript: callScript
};
