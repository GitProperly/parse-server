'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RoleCache = undefined;

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _node = require('parse/node');

var _node2 = _interopRequireDefault(_node);

var _lruCache = require('lru-cache');

var _lruCache2 = _interopRequireDefault(_lruCache);

var _logger = require('../logger');

var _logger2 = _interopRequireDefault(_logger);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function rolesForUser(userId) {
  var q = new _node2.default.Query(_node2.default.Role);
  var user = new _node2.default.User();
  user.id = userId;
  q.equalTo("users", user);
  return q.find({ useMasterKey: true });
}

var RoleCache = function () {
  function RoleCache() {
    var timeout = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 30 * 24 * 60 * 60 * 1000;
    var maxSize = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 10000;

    _classCallCheck(this, RoleCache);

    this.cache = new _lruCache2.default({
      max: maxSize,
      maxAge: timeout
    });
  }

  _createClass(RoleCache, [{
    key: 'getRoles',
    value: function getRoles(userId) {
      var _this = this;

      if (!userId) {
        return _node2.default.Promise.error('Empty userId');
      }
      var cachedRoles = this.cache.get(userId);
      if (cachedRoles) {
        _logger2.default.verbose('Fetch %s roles of user %s from Cache', cachedRoles.length, userId);
        return _node2.default.Promise.as(cachedRoles);
      }
      return rolesForUser(userId).then(function (roles) {
        _logger2.default.verbose('Fetch %s roles of user %s from Parse', roles.length, userId);
        var roleNames = roles.map(function (role) {
          return role.getName();
        });
        _this.cache.set(userId, roleNames);
        return _node2.default.Promise.as(roleNames);
      }, function (error) {
        _logger2.default.error('Can not fetch roles for userId %j, error %j', userId, error);
        return _node2.default.Promise.error(error);
      });
    }
  }]);

  return RoleCache;
}();

exports.RoleCache = RoleCache;