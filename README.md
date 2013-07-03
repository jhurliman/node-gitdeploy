# gitdeploy

Listen for git web hooks and automatically update and deploy code.

## Install

The source is available for download from
[GitHub](http://github.com/jhurliman/node-gitdeploy). Clone the repository,
copy `config.local.js.orig` to `config.local.js` and edit it to suit your needs
(see below). Run `npm install` to install dependencies, then run
`node index.js` and confirm the service successfully starts. Although the
service should be stable, you will probably want to run it via a process
supervisor such as [pm2](https://github.com/Unitech/pm2), [monit](http://mmonit.com/monit/), [forever](https://github.com/nodejitsu/forever), [supervisord](http://supervisord.org/), etc.

## Configuration

  * **web_port** - The HTTP port to listen to. Default is 23200.
  * **run_as_user** - Switch the process to another user after it has started.
    This is useful for running as root and logging to ie
    /var/log/gitdeploy.log, then dropping root privileges. Defaults to empty.
  * **log_path** - Relative or absolute path for the log file. Defaults to
    gitdeploy.log.
  * **log_level** - Logging verbosity. Valid values are debug, info, warn, and
  error. Defaults to debug.
  * **forward_to** - An optional array of URLs to forward incoming pings to.
    Useful for pinging servers that are not publicly accessible.
  * **repositories** - An array of repository objects describing local
    git clones. Each repository object consists of the following fields:
    * **url** - Public web URL of the repository. This must match what
    GitHub/Bitbucket/etc send exactly. An example is
    <https://github.com/jhurliman/Test-Repo>.
    * **path** - Local path to the cloned repository. This must be an absolute
    path.
    * **deploy** - (Optional) A script or shell command to run after git pull
    has finished. This is usually a deployment or notification script.
