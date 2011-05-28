var events = require("events");
var pulse = require("pulse");
var http = require("http");

////////////////////////////////////////////////////////////////////////////////
//// Constants

var kTboxDelay = 60 * 1000; // 60 seconds
var kBuildbotSuccess = 0;
var kBuildbotWarning = 1;
var kBuildbotFailure = 2;

////////////////////////////////////////////////////////////////////////////////
//// Local Methods

function getEventFromType(type)
{
  switch(type) {
    case kBuildbotSuccess:
      return "success";
    case kBuildbotWarning:
      return "warning";
    case kBuildbotFailure:
      return "failure";
  }
}

function createBuildData(m)
{
  var builddata = {
    key: m._meta.routing_key,
    buildid: undefined,
    platform: undefined,
    slave: undefined,
    rev: undefined,
    result: m.payload.results[0], // a kBuildbot* constant
  };

  // Scan through the properties object to find the data we care about.  I
  // really wish this was formatted in a more usable manner.
  m.payload.properties.forEach(function(property) {
    switch (property[0]) {
      case "buildid":
        builddata.buildid = property[1];
        break;
      case "platform":
         builddata.platform = property[1];
        break;
      case "slavename":
        builddata.slave = property[1];
        break;
      case "revision":
        builddata.rev = property[1].substr(0, 12);
        break;
    }
  });

  if (!builddata.rev) {
    console.error(m.payload.properties);
  }

  return builddata;
}

function getLogPath(cset, slave, callback)
{
  console.info("Looking for " + cset + " on " + slave);
  // Get the JSON because Pulse knows nothing about where the logs are :(
  var req = http.get({host: "tinderbox.mozilla.org",
                      path: "/Firefox/json2.js"}, function(res) {
    var str = "";
    res.setEncoding("utf8");
    res.on("data", function(chunk) {
      str += chunk;
    });
    res.on("end", function() {
      var builds = JSON.parse(str).builds;
      /* Format looks like:
        { warnings_enabled: 0,
          buildname: 'Rev3 WINNT 6.1 mozilla-central debug test crashtest',
          errorparser: 'unittest',
          ignored: 0,
          scrape_enabled: 1,
          scrape: 
            [" s: talos-r3-fed64-039",
             "<a href=http://hg.mozilla.org/mozilla-central/rev/c6d349c58bd7 title=\"Built from revision c6d349c58bd7\">rev:c6d349c58bd7</a>",
             " crashtest<br/>1840/0/10"],
             ...
            ],
          buildstatus: 'success',
          endtime: '1306535472',
          buildtime: '1306534519',
          logfile: '1306534519.1306535368.11955.gz' },
      */
      for (var i = 0; i < builds.length; i++) {
        if (!builds[i].scrape) {
          continue;
        }

        var scrape = builds[i].scrape;
        if (scrape[0].indexOf(slave) != -1 && scrape[1].indexOf(cset) != -1) {
          try {
            callback(builds[i].logfile);
          }
          catch (e) {
            console.error(e.stack);
          }
          return;
        }
      }
      console.error("no dice, so trying again for " + cset);

      // We didn't find it.  Reschedule ourselves to look again...
      setTimeout(function() { getLogPath(cset, slave, callback); }, kTboxDelay);
    });
  }).on("error", function(e) {
    console.error(e.stack);
  });
}

function messageConsumer(message)
{
  var key = message._meta.routing_key;
  // Filter on our tree.  Do not need to do this after bug 659776 is fixed.
  if (key.indexOf(this.tree) == -1) {
    return;
  }

  var data = createBuildData(message);

  // On warning (orange) or error (red), we need to get the log filename first.
  if ((data.result == kBuildbotWarning && this.listeners("warning").length) ||
      (data.result == kBuildbotFailure && this.listeners("failure").length)) {
    var handleLog = function(log) {
      data.logfile = log;
      this.emit(getEventFromType(data.result), data);
    }.bind(this);

    // Give tinderbox time to process the log file.  It may not happen by, then
    // though...
    setTimeout(function() { getLogPath(data.rev, data.slave, handleLog); },
               kTboxDelay);
  }
  // On success we can notify immediately.
  else if (data.result == kBuildbotSuccess) {
    this.emit(getEventFromType(data.result), data);
  }
}

////////////////////////////////////////////////////////////////////////////////
//// Exports

function Watcher(tree)
{
  if (!tree) {
    tree = "mozilla-central";
  }
  this.tree = tree;

  // Lazily initialize ourselves when we actually get a listener.
  this.once("newListener", function() {
    var types = [
      // Whitelist only tests that are run on mozilla-central.
      "mochitest-ipcplugins",
      "mochitest-a11y",
      "mochitest-plain-1",
      "mochitest-plain-2",
      "mochitest-plain-3",
      "mochitest-plain-4",
      "mochitest-plain-5",
      "mochitest-chrome",
      "mochitest-browser-chrome",
      "reftest",
      "reftest-ipc",
      "jsreftest",
      "jetpack",
      "xpcshell",
    ];

    var topics = [];
    types.forEach(function(type) {
      topics.push("build.#.step.#." + type + ".finished");
    });
    this._connection = new pulse.BuildConsumer("build-watcher",
                                               messageConsumer.bind(this),
                                               topics);
  }.bind(this));
}

Watcher.prototype = Object.create(events.EventEmitter.prototype);

Watcher.__defineGetter__("kBuildbotSuccess", function() { return kBuildbotSuccess; });
Watcher.__defineGetter__("kBuildbotWarning", function() { return kBuildbotWarning; });
Watcher.__defineGetter__("kBuildbotFailure", function() { return kBuildbotFailure; });

exports.Watcher = Watcher;
