var async = require('async');
var nconf = require('nconf');
var log = require('winston');
var express = require('express');
var request = require('request');
var exec = require('child_process').exec;
var utils = require('./utils');

var PULL_TIMEOUT_MS = 1000 * 60 * 20; // 20 minutes
var DEPLOY_TIMEOUT_MS = 1000 * 60 * 20; // 20 minutes

main();


function main() {
  // Load config settings
  nconf
    .argv()
    .env()
    .file('user', __dirname + '/config.local.json')
    .file('base', __dirname + '/config.json');

  // Setup console logging
  log.loggers.options.transports = [];
  log.remove(log.transports.Console);
  var logger = log.add(log.transports.Console, { level: nconf.get('log_level'),
    colorize: true, timestamp: utils.shortDate });
  log.loggers.options.transports.push(logger.transports.console);

  // Make sure we have permission to bind to the requested port
  if (nconf.get('web_port') < 1024 && process.getuid() !== 0)
    throw new Error('Binding to ports less than 1024 requires root privileges');

  var app = module.exports = express();

  app.disable('x-powered-by');
  app.use(utils.catchRequestErrors);
  app.use(express.urlencoded());

  // Setup request logging
  app.use(utils.requestLogger({ transports: log.loggers.options.transports }));

  // Load the request handler
  app.post('/', postHook);

  // Setup error handling/logging
  app.all('*', utils.handle404);
  app.use(app.router);
  app.use(utils.requestErrorLogger({ transports: log.loggers.options.transports }));
  app.use(utils.handle500);

  // Start listening for requests
  app.listen(nconf.get('web_port'), listeningHandler);
}

function listeningHandler() {
  // If run_as_user is set, try to switch users
  if (nconf.get('run_as_user')) {
    try {
      process.setuid(nconf.get('run_as_user'));
      log.info('Changed to running as user ' + nconf.get('run_as_user'));
    } catch (err) {
      log.error('Failed to change to user ' + nconf.get('run_as_user') + ': ' + err);
    }
  }

  // Now that we've dropped root privileges (if requested), setup file logging
  // NOTE: Any messages logged before this will go to the console only
  if (nconf.get('log_path')) {
    var logger = log.add(log.transports.File, { level: nconf.get('log_level'),
      filename: nconf.get('log_path') });
    log.loggers.options.transports.push(logger.transports.file);
  }

  log.info('gitdeploy is listening on port ' + nconf.get('web_port'));
}

function postHook(req, res, next) {
  var payload;
  try { payload = JSON.parse(req.body.payload); }
  catch (ex) { return next(ex); }

  if (!payload.repository)
    return next('Unrecognized payload: ' + req.body.payload);

  // Get the URL of the repository that this ping is about
  var repoUrl = (payload.canon_url) ?
    payload.canon_url + payload.repository.absolute_url :
    payload.repository.url;
  if (!repoUrl)
    return next('Unknown repository url in payload: ' + req.body.payload);

  log.info('Received a ping for repository ' + repoUrl);

  // Forward this request
  var forwards = nconf.get('forward_to');
  if (forwards) {
    forwards.forEach(function(url) {
      log.info('Forwarding ping to ' + url);
      request.post({ url: url, body: 'payload=' + req.body.payload }, function(err) {
        if (err)
          log.warn('Failed to forward ping to ' + url + ': ' + err);
        else
          log.info('Successfully forwarded ping to ' + url);
      });
    });
  }

  // Get the list of configured repositories
  var repos = nconf.get('repositories');
  if (!repos)
    return res.send('OK');

  // Find configured repositories that match the current repo ping
  repos = repos.filter(function(repo) { return repo.url === repoUrl; });
  if (!repos.length)
    return res.send('OK');

  // Update/deploy each configured repository matching the current ping
  async.eachSeries(repos, updateRepo,
    function(err) {
      if (err)
        log.error(err);
      else
        log.info('Finished updating all repositories');
    }
  );

  res.send('OK');
}

function updateRepo(repo, callback) {
  log.info('Updating repository ' + repo.path);
  exec('git pull', { cwd: repo.path, timeout: PULL_TIMEOUT_MS }, function(err, stdout, stderr) {
    if (err || stderr)
      return callback('git pull in ' + repo.path + ' failed: ' + (err || stderr.trim()));

    log.debug('[git pull] ' + stdout.trim());
    log.info('Updated repository ' + repo.url + ' -> ' + repo.path);

    if (!repo.deploy)
      return callback();

    log.info('Running deployment "' + repo.deploy + '"');
    exec(repo.deploy, { cwd: repo.path, timeout: DEPLOY_TIMEOUT_MS }, function(err, stdout, stderr) {
      if (err || stderr)
        return callback('Deploy "' + repo.deploy + '" failed: ' + (err || stderr.trim()));

      log.debug('[' + repo.deploy + '] ' + stdout.trim());
      log.info('Finished deployment "' + repo.deploy + '"');

      callback();
    });
  });
}
