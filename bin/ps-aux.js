'use strict'

var psaux = require('../')()

var time = setInterval(() => {
  psaux.parsed(function(err, res){
    if (err) {
      console.error(err)
      clearInterval(time)
      process.exit(1)
    }
    console.log(res[0], res[1])
    console.log('sleeping 2 seconds...')
  })
}, 2000)
