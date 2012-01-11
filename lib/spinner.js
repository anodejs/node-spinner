var spawn = require('child_process').spawn;
var fs = require('fs');
var path = require('path');

var fsmjs = require('fsmjs');
var async = require('async');
var portscanner = require('portscanner');
var ctxobj = require('ctxobj');

exports.createSpinner = function(globalOptions) {
	var api = {};

	// default options
	globalOptions = globalOptions || { };
	globalOptions.command = globalOptions.command || process.execPath;
	globalOptions.timeout = globalOptions.timeout || 5;
	globalOptions.attempts = globalOptions.attempts || 3;
	globalOptions.stopTimeout = globalOptions.stopTimeout || 30;
	globalOptions.stdout = globalOptions.stdout || null;
	globalOptions.stderr = globalOptions.stderr || null;
	globalOptions.logger = globalOptions.logger || ctxobj.console(console);
	globalOptions.env = globalOptions.env || { };
	globalOptions.cwd = globalOptions.cwd || null;
	globalOptions.range = globalOptions.range || [ 7000, 7999 ];

	api.start = function(options, callback) {
		if (!callback) callback = function() {};
		if (!options) throw new Error("first argument should be a options hash or a script path");

		// if options is a string, treat as script
		if (typeof options === "string") options = { script: options };

		// if script is provided, use it as the first argument
		if (options.script) {
			options.name = options.name || options.script;
			
			if (options.args) options.args.unshift(options.script);
			else options.args = [ options.script ];

			if (!options.monitor) {
				var fn = options.script;

				// if the script doesn't end with '.js', append it.
				if (path.extname(fn) === '') fn += ".js";

				options.monitor = fn;
			}

			delete options.script;
		}

		// if command is not provided, default to node.js
		options.command = options.command || globalOptions.command;
		
		// logger can be overriden
		var logger = options.logger || globalOptions.logger;
		delete options.logger;
		logger = ctxobj.console(logger).pushctx(options.name);

		// default wait timeout is 5 seconds
		options.timeout = options.timeout || globalOptions.timeout;

		// default number of start attempts before staying in 'faulted' is 3
		options.attempts = options.attempts || globalOptions.attempts;

		// stop timeout defaults to 30 sec
		options.stopTimeout = options.stopTimeout || globalOptions.stopTimeout;

		// environment hash
		options.env = options.env || globalOptions.env;

		// pipe stdout/stderr
		options.stdout = options.stdout || globalOptions.stdout;
		options.stderr = options.stderr || globalOptions.stderr;

		// port range
		options.range = options.range || globalOptions.range;

		// working directory
		options.cwd = options.cwd || null;

		// make sure we have a name
		if (!options.name) throw new Error('options.name is required');

		// obtain a spinner obj
		var fsm = spinner(options.name);

		// store options & logger
		fsm.options = options;
		fsm.logger = logger;
		fsm.name = options.name;
		
		function _onSuccess() {
			_removeListeners();
			return callback(null, fsm.port);
		}

		function _onFailure() {
			_removeListeners();
			return callback(new Error("unable to start"));
		}

		function _removeListeners() {
			fsm.removeListener('started', _onSuccess);
			fsm.removeListener('restarted', _onSuccess);
			fsm.removeListener('error', _onFailure);
		}

		fsm.once('started', _onSuccess);
		fsm.once('restarted', _onSuccess);
		fsm.once('error', _onFailure);

		fsm.setMaxListeners(1000);

		// hit it
		fsm.trigger('start');
		return fsm;
	};

	api.stop = function(script, callback) {
		if (!callback) callback = function() {};
		var fsm = spinner(script);

		fsm.once('stopped', function(status) {
			return callback(null, status);
		});

		fsm.once('error', function(e) {
			return callback(e);
		});

		fsm.trigger('stop');
		return fsm;
	};

	api.stopall = function(callback) {
		if (!callback) callback = function() {};
		return async.forEach(
			Object.keys(spinnerByName), 
			function(name, cb) { api.stop(name, cb); }, 
			callback);
	};

	api.list = function() {
		var result = {};
		for (var name in spinnerByName) {
			result[name] = api.get(name);
		}
		return result;
	};

	api.get = function(name) {
		var fsm = spinnerByName[name];
		if (!fsm) return null;

		var desc = fsm.options;

		switch (fsm.state) {
			case 'start':
			case 'wait':
				desc.state = 'starting';
				break;
			
			case 'stop':
				desc.state = 'stopping';
				break;

			case 'restart':
				desc.state = 'restarting';
				break;

			default:
				desc.state = fsm.state;
				break;
		}

		return desc;	
	}

	// -- implementation

	var usedPorts = {}; // handle multiple attempts to bind to the same port
	var spinnerByName = {}; // hash of all the spinners by name

	function spinner(name) {
		var fsm = spinnerByName[name];
		if (fsm) return fsm;

		var spinner = {

			stopped: {
				$enter: function(cb) {
					spinner.qemit('stopped');
					return cb();
				},
					
				start: function(cb) {
					spinner.logger.log('starting', spinner.options.name);
					spinner.state = 'start';
					return cb();
				},

				stop: function(cb) {
					spinner.logger.log('already stopped');
					spinner.trigger('$enter');
					return cb();
				},
			},

			start: {
				$enter: function(cb) {
					
					function _findport(from, to, callback) {
						spinner.logger.log('looking for an available port in the range:', [from, to]);
						return portscanner.findAPortNotInUse(from, to, 'localhost', function(err, port) {
							if (err) {
								spinner.logger.error('unable to find available port for child', err);
								return callback(err);
							}

							if (port in usedPorts) {
								spinner.logger.log('Port ' + port + ' is already used, trying from ' + (port + 1));
								return _findport(port + 1, to, callback);
							}

							usedPorts[port] = true;
							return callback(null, port);
						});
					}

					_findport(spinner.options.range[0], spinner.options.range[1], function(err, port) {
						if (err) return spinner.trigger('portNotFound');
						else return spinner.trigger('portAllocated', port);
					});

					return cb();
				},

				portNotFound: function(cb) {
					spinner.logger.error('out of ports... sorry... try again later');
					spinner.state = 'faulted';
					return cb();
				},

				portAllocated: function(cb, port) {
					spinner.logger.log('found port', port);

					// spawn the child process and store state
					spinner.port = port;
					spinner.logger.info('spawn', spinner.options.command, spinner.options.args);
					var env = spinner.options.env || {};
					env.port = env.PORT = spinner.port;
					var cwd = spinner.options.cwd;
					spinner.child = spawn(spinner.options.command, spinner.options.args, { env: env, cwd: cwd });
					spinner.child.on('exit', function(code, signal) { return spinner.trigger('term', code, signal); });
					spinner.child.stdout.on('data', function(data) { return spinner.emit('stdout', data); });
					spinner.child.stderr.on('data', function(data) { return spinner.emit('stderr', data); });

					// pipe stdout/stderr if requested 
					//   keep the original streams opened after close event 
					//   as of node 0.6+ process.stdout.end() throws
					if (spinner.options.stdout) spinner.child.stdout.pipe(spinner.options.stdout, { end: false });
					if (spinner.options.stderr) spinner.child.stderr.pipe(spinner.options.stderr, { end: false });

					spinner.state = 'wait';

					return cb();
				},
				
				start: function(cb) {
					spinner.logger.log('start already pending');
					return cb();
				},

				term: 'faulted',
			},

			wait: {
				$enter: function(cb) {
					spinner.logger.log('waiting for port ' + spinner.port + ' to be bound');
					spinner.wait.tries = spinner.options.timeout * 2;
					spinner.wait.backoff = 500;

					// will begin scanning
					spinner.trigger('wait');

					return cb();
				},

				wait: function(cb) {
					spinner.logger.log('checking status of port ' + spinner.port, 'tries left:', spinner.wait.tries);

					if (spinner.wait.tries-- === 0) {
						spinner.logger.warn('timeout waiting for port');
						return spinner.trigger('waitTimeout');
					}

					portscanner.checkPortStatus(spinner.port, 'localhost', function(err, status) {
						spinner.logger.log('status is', status);
						if (status === "open") return spinner.trigger("opened");
						else return spinner.waitTimeout = spinner.timeout("wait", spinner.wait.backoff);
					});

					return cb();
				},

				term: function(cb) {
					spinner.logger.error('process terminated while waiting');
					spinner.state = 'faulted';
					return cb();
				},

				waitTimeout: function(cb) {
					spinner.logger.error('timeout waiting for port ' + spinner.port);
					spinner.child.kill();
					spinner.state = 'faulted';
					return cb();
				},

				opened: function(cb) {
					spinner.logger.log('port ' + spinner.port + ' opened successfuly');
					spinner.state = 'started';
					return cb();
				},

				start: function(cb) {
					spinner.logger.log('start already pending');
					return cb();
				},

				stop: function(cb) {
					spinner.logger.log('stop waiting for child to start');
					spinner.state = 'stop';
					cb();
				},
				
				$exit: function(cb) {
					if (spinner.waitTimeout) {
						spinner.logger.log('clearing wait timeout');
						clearTimeout(spinner.waitTimeout);
					}
					return cb();
				},
			},

			faulted: {
				$enter: function(cb) {
					spinner._cleanup();

					spinner.faulted.count = spinner.faulted.count ? spinner.faulted.count + 1 : 1;
					spinner.logger.warn('faulted (' + spinner.faulted.count + '/' + spinner.options.attempts + ')');

					if (spinner.faulted.count > spinner.options.attempts) {
						spinner.logger.error('fault limit reached. staying in "faulted" state');
					}
					else {
						spinner.logger.log('moving to stopped state');
						spinner.state = 'stopped';
					}

					spinner.qemit('error', new Error("unable to start child process"));
					return cb();
				},

				stop: function(cb) {
					spinner.logger.log('moving to stop after faulted');
					spinner.state = 'stopped';
					spinner.faulted.count = 0; // reset fault caount
					return cb();
				},

				start: function(cb) {
					spinner.qemit('error', new Error('start failed to start for ' + spinner.options.attempts + ' times, stop before start'));
					return cb();
				},

				'.*': function(cb, e) {
					spinner.logger.error(e, 'triggered while in start-fault');
					return cb();
				},
			},
			
			started: {
				$enter: function(cb, prev) {

					// start file monitor, if defined
					if (spinner.options.monitor) {
						if (!spinner.watch) {
							spinner.watch = fs.watch(spinner.options.monitor, function(event) {
								spinner.trigger('changed');
							});
						}
					}

					// do not emit 'started' if we came from the same state
					if (spinner.started.emit) {
						spinner.qemit(spinner.started.emit, spinner.port);
						delete spinner.started.emit;
					}
					else {
						spinner.qemit('started', spinner.port);
					}

					return cb();
				},

				start: function(cb) {
					spinner.logger.log('already started');
					spinner.trigger('$enter');
					return cb();
				},

				stop: function(cb) {
					spinner.logger.log('stopping');
					spinner.state = 'stop'
					return cb();
				},

				term: function(cb) {
					spinner.logger.warn('child terminated unexpectedly, restarting');
					spinner.state = "restart";
					return cb();
				},

				changed: function(cb) {
					spinner.logger.log('"' + spinner.options.monitor + '"', 'changed');
					
					// restart the child (bruite force for now)
					spinner.child.kill();
					spinner.state = "restart";
										
					return cb();
				},

				$exit: function(cb) {

					// stop file watch
					if (spinner.watch) {
						spinner.watch.close();
						spinner.watch = null;
					}

					return cb();
				},
			},

			// helper function that cleans up the spinner in case we killed the process
			_cleanup: function() {
				spinner.child.removeAllListeners();
				spinner.child = null;
				delete usedPorts[spinner.port];
				spinner.port = null;
			},

			stop: {
				$enter: function(cb) {
					spinner.child.kill();
					spinner.stop.timeout = spinner.timeout('stopTimeout', spinner.options.stopTimeout * 1000);
					cb();
				},

				term: function(cb, status) {
					spinner.logger.log('exited with status', status);
					spinner.exitStatus = status;
					spinner.state = 'stopped';
					return cb();
				},

				stopTimeout: function(cb) {
					spinner.logger.log('stop timeout. sending SIGKILL');
					spinner.child.kill('SIGKILL');
					spinner.state = 'stopped';
					return cb();
				},

				$exit: function(cb) {
					spinner.logger.log('cleaning up');
					clearTimeout(spinner.stop.timeout);
					spinner._cleanup();
					return cb();
				},
			},

			restart: {
				$enter: function(cb) {
					spinner.logger.log('restarting');
					spinner._cleanup();
					spinner.state = 'start';
					spinner.started.emit = "restarted";
					return cb();
				},
			},
 
 			assert: function(cb, err) {
				spinner.logger.error('assertion', err);
				return cb();
			},
		};

		return spinnerByName[name] = fsmjs(spinner);
	}

	return api;	
};