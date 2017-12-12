const codemap = require('codemap');

module.exports = () => {
  const rootMap = {
    _maps: [require('./_codemap')],

    get: function container(get, set) {
      return get;
    },
    set: function container(get, set) {
      return set;
    },
    use: function container() {
      return function use() {
        [].slice.call(arguments).forEach(arg => {
          instance.parseMap(arg);
        });
        instance.validatePathCache();
      };
    },
  };
  const instance = codemap(rootMap);

  return instance.export();
};

module.exports.version = require('./package.json').version;
