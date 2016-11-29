'use strict';
var ChildProcess = require('child_process');
var os = require('os');
var EventEmitter  = require('events').EventEmitter
  , inherits = require('util').inherits
  , extend = require('util')._extend;
var TableParser = require('table-parser');

var EOL = /\r\n|\n\r|\n|\r/;
var SystemEOL = require('os').EOL;

/**
 * Parses out process info from a given `ps aux` line.
 *
 * @name parseLine
 * @private
 * @function
 * @param {string} line the raw info for the given process
 * @return {Object} with parsed out process info
 */
function parseLine(line) {
  // except for the command, no field has a space, so we split by that and piece the command back together
  var parts = line.split(/ +/);
  return {
      user    : parts[0]
    , pid     : parseInt(parts[1])
    , '%cpu'  : parseFloat(parts[2])
    , '%mem'  : parseFloat(parts[3])
    , vsz     : parseInt(parts[4])
    , rss     : parseInt(parts[5])
    , tty     : parts[6]
    , state   : parts[7]
    , started : parts[8]
    , time    : parts[9]
    , command : parts.slice(10).join(' ')
  }
}

/**
 * Creates a `psaux` object.
 * 
 * @name Psaux
 */
function Psaux() {
  EventEmitter.call(this);
  this._intervalToken = undefined;
}

inherits(Psaux, EventEmitter);
var instance = new Psaux();

module.exports = function(){
  return instance;
}

/**
 * Obtains raw process information
 * 
 * @name psaux::obtain
 * @function
 * @param {function} cb called back with an array of strings each containing information of a running process
 */
Psaux.prototype.obtainTasklist =  function (callback) {

  var self = this;
  var totalMemory = os.totalmem() / 1024;
  ChildProcess.exec('tasklist.exe /V', function( err, stdout, stderr) {
    if (err || stderr) return callback( err || stderr.toString() );
    var taskList = stdout;

    ChildProcess.exec('wmic process get CommandLine, name, ProcessId', function( err, stdout, stderr) {
      if (err || stderr) return callback( err || stderr.toString() );
      var wmicList = stdout;

      var taskListGrid = TableParser.parse(taskList);
      var wmicListGrid = TableParser.parse(wmicList);

      taskListGrid = taskListGrid.slice(1,-1); // remove header separator

      var totalCpuTime = 0;

      function parseTaskList (grid) {
        var pid = parseInt(grid['PID'][0]);
        var cpu = grid['CPU'][0].split(':');
        var cpuTime = ( parseInt(cpu[0]) * 3600 + parseInt(cpu[1]) * 60 + parseInt(cpu[0]) );

        var found = wmicListGrid.find(function(line){
          return line['ProcessId'][0] == pid;
        });

        var cmdName = ( found ? found['CommandLine'] : grid['Name'] ).join(' ');

        totalCpuTime += cpuTime;

        var mem = ( (parseFloat(grid['Mem'][0]) * 100) / totalMemory ).toFixed(2);
        var state = grid['Status'].join(' ');

        var info = {
          user    : grid['User'].join('_'),
          pid     : pid,
          '%cpu'  : cpuTime,
          '%mem'  : mem.toString(),
          vsz     : 'VSZ',
          rss     : 'RSS',
          tty     : 'TTY',
          state   : /unknown/i.test(state) ? '-' : state,
          started : '-',
          time    : grid['Time'][0],
          command : cmdName
        };
        return info;
      }

      var psList = taskListGrid.map(parseTaskList);

      for(var i=0; i<psList.length; i++){
        var time = psList[i]['%cpu'];
        psList[i]['%cpu'] = ( (parseFloat(time) * 100) / totalCpuTime ).toFixed(2).toString();
      }

      callback(null, psList);

    });
  });
}


Psaux.prototype.obtainPsaux = function (callback) {
  var self = this;
  ChildProcess.exec('ps aux', function( err, stdout, stderr) {
    if (err || stderr) return callback( err || stderr.toString() );

    stdout = stdout.toString().split('\n').slice(1, -1);
    callback( null, stdout.map(parseLine||false) );
  });
};

/**
 * Obtains process information and parses it.
 *
 * ### VSZ
 *
 * VSZ is the Virtual Memory Size. It includes all memory that the process can
 * access, including memory that is swapped out and memory that is from shared
 * libraries.
 *
 * ### RSS
 *
 * RSS is the Resident Set Size and is used to show how much memory is
 * allocated to that process and is in RAM. It does not include memory that is
 * swapped out. It does include memory from shared libraries as long as the
 * pages from those libraries are actually in memory. It does include all stack
 * and heap memory.
 * 
 * @name psaux::parsed
 * @function
 * @param {function} cb called back with an array containing running process information
 *
 * **process info:**
 *
 *  - **user**    : id of the user that owns the process
 *  - **pid**     : process id
 *  - **%cpu**    : percent of the CPU usage
 *  - **%mem**    : percent memory usage
 *  - **vsz**     : virtual memory size
 *  - **rss**     : resident set size
 *  - **tty**     : controlling terminal
 *  - **state**   : current state of the process (i.e. sleeping)
 *  - **started** : start time of process
 *  - **time**    : how long the process is running
 *  - **command** : command line used to start the process (including args)
 */
Psaux.prototype.parsed = function (cb) {
  var self = this;
  if(process.platform == "win32"){

    self.obtainTasklist(function (err, lines) {
      if (err) return cb(err);
      cb(null, lines);
    });

  } else {

    self.obtainPsaux(function (err, lines) {
      if (err) return cb(err);
      cb(null, lines);
    });

  }
}

function onprocessInfo(psaux, err, res) {
  // don't emit anything if interval was cleared int he meantime
  if (!psaux._intervalToken) return;

  if (err) return psaux.emit('error', err);
  psaux.emit('info', res);
}

function onobtain(psaux) { 
  psaux.obtain(onobtained)
  function onobtained(err, res) { onprocessInfo(psaux, err, res) }
}

function onobtainParsed(psaux) { 
  psaux.parsed(onparsed)
  function onparsed(err, res) { onprocessInfo(psaux, err, res) }
}

/**
 * Causes the psaux object to obtain process information at the given interval
 * and emit an event for each.
 * When invoked, previously set intervals are cancelled.
 * 
 * @name psaux::setInterval
 * @function
 * @param {Object} opts options 
 * @param {boolean} opts.parsed if true, the process information is parsed before it is emitted (default: `true`)
 * @param {number} opts.interval interval in milliseconds at which to emit process information (default: `20,000`)
 */
Psaux.prototype.setInterval = function setInterval_(opts) {
  opts = extend({ parsed: true, interval: 20000 }, opts);

  this.clearInterval();

  if (opts.parsed) 
    this._intervalToken = setInterval(onobtainParsed, opts.interval, this)
  else 
    this._intervalToken = setInterval(onobtain, opts.interval, this)
}

/**
 * Clears any previously registered interval at which process information was obtained
 * and emitted.
 *
 * @see psaux::setInterval
 * 
 * @name psaux::clearInterval
 * @function
 */
Psaux.prototype.clearInterval = function clearInterval_() {
  clearInterval(this._intervalToken);
  this._intervalToken = undefined;
}
