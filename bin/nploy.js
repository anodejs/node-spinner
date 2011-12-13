#!/usr/bin/env node

// config
var startPort = 7000
var endPort = 7002
var port = startPort
var timeToIdle = 1000 * 5

var proxyPort = +process.argv[2] || 80
var proxyHost = process.argv[3] || '0.0.0.0'

// modules
var fs = require('fs')
var cp = require('child_process')
var spawn = cp.spawn
var exec = cp.exec
var httpProxy = require('http-proxy')
var os = require('os')
var windows = os.platform() === 'win32' ? true : false
var atomic = require('atomic')()

var ports = []
var pids = []

console.log('-----------')
console.log('-- nploy --')
console.log('-----------')

var routes = (function () {
  console.log('routes:\n')
  var routes = {}
  var cfg = fs.readFileSync('./nploy.cfg', 'utf8')
  cfg.split(/\r\n|\r|\n/gim).forEach(function (line) {
    console.log(line)
    if (!line.trim().length) return
    var hostname = line.split(' ')[0]
    var target = line.split(' ')[1]
    var www = hostname.substr(0, 4) === 'www.'
    if (www) {
      hostname = hostname.substr(4)
    }
    routes[hostname] = {
      app: target
    , www: www
    , pid: null
    , host: hostname
    , port: null
    , lastAccessTime: 0
    }
  })
  return routes
}())

httpProxy.createServer(function (req, res, proxy) {
  var buffer = httpProxy.buffer(req)

  if (!('host' in req.headers)) {
    return notFound(res)
  }
  var hostname = req.headers.host.toLowerCase()
  if (~hostname.indexOf(':')) hostname = hostname.split(':')[0]
  var www = hostname.substr(0, 4) === 'www.'
  if (www) {
    hostname = hostname.substr(4)
  }
  if (!(hostname in routes)) {
    return notFound(res)
  }
  var app = routes[hostname]
  if (www && !app.www) {
    return redirect(hostname, res)
  }
  else if (!www && app.www) {
    return redirect('www.' + hostname, res)
  }
  
  req.headers.ip = req.connection.remoteAddress
  
  app.lastAccessTime = Date.now()

  if (!app.pid) {
    runChild(app, function (err) {
      if (!err && app.pid) {
        proxy.proxyRequest(req, res, {
          host: app.host
        , port: app.port
        , buffer: buffer
        })
      }
      else notFound(res)
    })
  }
  else {
    proxy.proxyRequest(req, res, {
      host: app.host
    , port: app.port
    , buffer: buffer
    })
  }
}).listen(proxyPort, proxyHost, function () {
  console.log('listening on http://' + proxyHost + ':' + proxyPort + '/')
})

function runChild (app, callback) {
  var child
  while (~ports.indexOf((app.port = port++))) {}
  if (port > endPort) port = startPort
  ports.push(app.port)

  log(app, 'running app')

  process.env.HOST = app.host
  process.env.PORT = app.port

  try {
    child = app.child = spawn('node', [ app.app ])
    app.pid = child.pid
    app.lastAccessTime = Date.now()
    pids.push(app.pid)
  } catch(e) {
    log(app, 'error')
    console.error(e.stack)
    return callback(e)
  }

  child.stdout.on('data', function (data) {
    process.stdout.write(data)
  })

  child.stderr.on('data', function (data) {
    process.stdout.write(data)
  })

  child.on('exit', function (err, sig) {
    pids.splice(pids.indexOf(app.pid), 1)
    ports.splice(ports.indexOf(app.port), 1)
    app.port = 0
    app.pid = null
    app.lastAccessTime = 0
    app.child = null
    log(app, 'exited')
  })
  
  // give it some time to initialize
  setTimeout(function () {
    callback()
  }, 4000)
}

function kill (pids, callback) {
  if (Array.isArray(pids) && !pids.length || !pids) {
    return callback(new Error('no running processes'))
  }
  if (windows) {
    exec('taskkill /F /T ' + (Array.isArray(pids) ? pids.map(function (el) { return '/PID ' + el }).join(' ') : '/PID ' + pids), callback)
  } else {
    exec('kill -9 ' + (Array.isArray(pids) ? pids.join(' ') : pids), callback)
  }
}

function idler () {
  atomic('idler', function (done) {
    var waitFor = 0
    Object.keys(routes).forEach(function (route) {
      var app = routes[route]
      if (app.child && app.lastAccessTime > 0) {
        var now = Date.now()
        if (now - app.lastAccessTime > timeToIdle) {
          waitFor++
          kill(app.pid, function (err, stdout, stderr) {
            process.stdout.write(stdout)
            if (stderr) {
              process.stderr.write(stderr)
            }
            pids.splice(pids.indexOf(app.pid), 1)
            ports.splice(ports.indexOf(app.port), 1)
            app.port = 0
            app.pid = null
            app.lastAccessTime = 0
            app.child = null
            log(app, 'idled')
            if (waitFor) {
              --waitFor || done()
            }
          })
        }
      }
    })
    if (!waitFor) done()
  })
}

setInterval(idler, 5000)

function pidTracker () {
  fs.writeFile('nploy.pids', JSON.stringify(pids), 'utf8')
}

;(function () {
  try {
    var json = fs.readFileSync('nploy.pids', 'utf8')
  }
  catch (e) {
    setInterval(pidTracker, 5000)  
    return
  }
  var data
  try {
    data = JSON.parse(json)
  }
  catch (e) {}
  if (data) {
    console.log('killing old processes...')
    kill(data, function (err) {
      if (err) {
        console.error(err.message)
      } else {
        console.log('old processes killed')
      }
      setInterval(pidTracker, 5000)
    })
  }
  else {
    setInterval(pidTracker, 5000)
  }
}())

function notFound (res) {
  res.writeHead(404, { 'Content-Type': 'text/html' })
  res.end('<h1>Not Found</h1><p>The URL you requested could not be found</p>')
}

function redirect (target, res) {
  res.writeHead(301, {
    'Content-Type': 'text/html'
  , 'Location': 'http://' + target 
  })
  return res.end('Moved <a href="http://' + target + '">here</a>')
}

function log () {
  var args = [].slice.call(arguments)
    , app = args.shift()

  args[args.length - 1] += ':'
  args.push(app.host + ':' + app.port, '-', app.app)

  console.log.apply(console, args)
}
