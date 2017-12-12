const glob = require('glob');

module.exports = cb => {
  const zenbot = require('./')();
  const defaults = require('./conf-sample');
  let c;
  try {
    c = require('./conf');
  } catch (e) {
    c = {};
  }
  Object.keys(defaults).forEach(k => {
    if (typeof c[k] === 'undefined') {
      c[k] = defaults[k];
    }
  });
  zenbot.set('@zenbot:conf', c);

  function withMongo() {
    // searches all directorys in {workingdir}/extensions/ for files called '_codemap.js'
    glob(
      'extensions/**/_codemap.js',
      { cwd: __dirname, absolute: true },
      (err, results) => {
        if (err) return cb(err);
        results.forEach(result => {
          const ext = require(result); // load the _codemap for the extension
          zenbot.use(ext); // load the extension into zenbot
        });
        cb(null, zenbot);
      },
    );
  }

  let u = `mongodb://${c.mongo.host}:${c.mongo.port}/${c.mongo.db}${
    c.mongo.replicaSet ? `?replicaSet=${c.mongo.replicaSet}` : ''
  }`;
  require('mongodb').MongoClient.connect(u, (err, db) => {
    if (err) {
      zenbot.set('zenbot:db.mongo', null);
      console.error(
        'warning: mongodb not accessible. some features (such as backfilling/simulation) may be disabled.',
      );
      return withMongo();
    }
    zenbot.set('zenbot:db.mongo', db);
    if (c.mongo.username) {
      db.authenticate(c.mongo.username, c.mongo.password, err2 => {
        if (err2) {
          zenbot.set('zenbot:db.mongo', null);
          console.error(
            'warning: mongodb auth failed. some features (such as backfilling/simulation) may be disabled.',
          );
        }
        withMongo();
      });
    } else {
      withMongo();
    }
  });
};
