var domain = require('domain');
var express = require('express');

exports.catchRequestErrors = catchRequestErrors;
exports.shortDate = shortDate;
exports.pad2 = pad2;
exports.handle404 = handle404;
exports.handle500 = handle500;
exports.requestLogger = requestLogger;
exports.requestErrorLogger = requestErrorLogger;

/**
 * Create a domain for each HTTP request to gracefully handle errors.
 */
function catchRequestErrors(req, res, next) {
  var d = domain.create();
  d.add(req);
  d.add(res);
  d.on('error', function(err) {
    try {
      res.on('close', function() { d.dispose(); });
      next(err);
    } catch (ex) {
      d.dispose();
    }
  });
  d.run(next);
}

/**
 * Returns a date string with the format "26 Feb 16:19:34".
 */
function shortDate(date) {
  var SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
    'Oct', 'Nov', 'Dec'];

  var d = date || new Date();
  return d.getDate() + ' ' + SHORT_MONTHS[d.getMonth()] + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/**
 * Convert a number to a string and pad numbers from [0-9] with a leading '0'.
 */
function pad2(n) {
  return n < 10 && n >= 0 ? '0' + n.toString(10) : n.toString(10);
}

function handle404(req, res, next) {
  res.send(404);
}

function handle500(err, req, res, next) {
  var contentType = res.getHeader('content-type') || '';

  if (req.xhr || contentType.indexOf('application/json') === 0) {
    // JSON
    res.send(500, { error: err.stack || err.toString() });
  } else {
    // Stack trace
    res.type('text/plain');
    res.send(500, err.stack || err.toString());
  }
}

/**
 * Log HTTP requests in common log format
 * (see http://httpd.apache.org/docs/1.3/logs.html#common).
 */
function requestLogger(options) {
  var STATUS_RE = /HTTP\/[\d\.]+" (\d+) /;

  return express.logger({ stream: {
    write: function(str) {
      // Remove any trailing newline in the log message
      if (str[str.length - 1] === '\n')
        str = str.substr(0, str.length - 1);

      // Parse the status code out of the message to determine an appropriate
      // log level
      var match = str.match(STATUS_RE);
      var level = (match && parseInt(match[1], 10) >= 400) ? 'warn' : 'info';

      for (var i = 0; i < options.transports.length; i++)
        options.transports[i].log(level, str, null, noOp);
    }
  } });
}

/**
 * Log detailed information about request errors.
 */
function requestErrorLogger(options) {
  var REQ_WHITELIST = ['url', 'headers', 'method', 'httpVersion', 'originalUrl', 'query'];

  return function(err, req, res, next) {
    var exMeta = {};
    if (err.stack)
      exMeta.stack = err.stack;
    else
      exMeta.error = '"' + err.toString() + '"';

    exMeta.req = {};
    REQ_WHITELIST.forEach(function(propName) {
      var value = req[propName];
      if (typeof (value) !== 'undefined')
        exMeta.req[propName] = value;
    });

    for (var i = 0; i < options.transports.length; i++)
      options.transports[i].logException('middlewareError', exMeta, noOp);

    next(err);
  };
}
