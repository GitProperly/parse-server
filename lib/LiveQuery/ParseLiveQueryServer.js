"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ParseLiveQueryServer = void 0;

var _tv = _interopRequireDefault(require("tv4"));

var _node = _interopRequireDefault(require("parse/node"));

var _Subscription = require("./Subscription");

var _Client = require("./Client");

var _ParseWebSocketServer = require("./ParseWebSocketServer");

var _logger = _interopRequireDefault(require("../logger"));

var _RequestSchema = _interopRequireDefault(require("./RequestSchema"));

var _QueryTools = require("./QueryTools");

var _ParsePubSub = require("./ParsePubSub");

var _SchemaController = _interopRequireDefault(require("../Controllers/SchemaController"));

var _lodash = _interopRequireDefault(require("lodash"));

var _uuid = _interopRequireDefault(require("uuid"));

var _triggers = require("../triggers");

var _Auth = require("../Auth");

var _Controllers = require("../Controllers");

var _lruCache = _interopRequireDefault(require("lru-cache"));

var _UsersRouter = _interopRequireDefault(require("../Routers/UsersRouter"));

var _AdapterLoader = require("../Adapters/AdapterLoader");

var _InMemoryCacheAdapter = require("../Adapters/Cache/InMemoryCacheAdapter");

var _CacheController = require("../Controllers/CacheController");

var _RedisCacheAdapter = _interopRequireDefault(require("../Adapters/Cache/RedisCacheAdapter"));

var _SessionTokenCache = require("./SessionTokenCache");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function getAllRolesNamesForRoleIds(roleIDs, names, queriedRoles) {
  const ins = roleIDs.filter(roleId => {
    return queriedRoles[roleId] !== true;
  }).map(roleId => {
    queriedRoles[roleId] = true;
    const role = new _node.default.Role();
    role.id = roleId;
    return role;
  });

  if (ins.length === 0) {
    return Promise.resolve([...names]);
  }

  const query = new _node.default.Query(_node.default.Role);
  query.containedIn('roles', ins);
  query.limit(10000);
  return query.find({
    useMasterKey: true
  }).then(roles => {
    if (!roles.length) {
      return Promise.resolve(names);
    }

    const ids = [];
    roles.map(role => {
      names.push(role.getName());
      ids.push(role.id);
      queriedRoles[role.id] = queriedRoles[role.id] || false;
    });
    return getAllRolesNamesForRoleIds(ids, names, queriedRoles);
  }).then(names => {
    return Promise.resolve([...names]);
  });
}

function defaultLoadRolesDelegate(auth) {
  return auth.getUserRoles();
}

class ParseLiveQueryServer {
  // className -> (queryHash -> subscription)
  // The subscriber we use to get object update from publisher
  constructor(server, config = {}) {
    this.server = server;
    this.clients = new Map();
    this.subscriptions = new Map();
    config.appId = config.appId || _node.default.applicationId;
    config.masterKey = config.masterKey || _node.default.masterKey; // Store keys, convert obj to map

    const keyPairs = config.keyPairs || {};
    this.keyPairs = new Map();

    for (const key of Object.keys(keyPairs)) {
      this.keyPairs.set(key, keyPairs[key]);
    }

    _logger.default.verbose('Support key pairs', this.keyPairs); // Initialize Parse


    _node.default.Object.disableSingleInstance();

    const serverURL = config.serverURL || _node.default.serverURL;
    _node.default.serverURL = serverURL;

    _node.default.initialize(config.appId, _node.default.javaScriptKey, config.masterKey); // The cache controller is a proper cache controller
    // with access to User and Roles


    this.cacheController = (0, _Controllers.getCacheController)(config); // Initialize cache

    if (config.cacheAdapter instanceof _RedisCacheAdapter.default) {
      const cacheControllerAdapter = (0, _AdapterLoader.loadAdapter)(config.cacheAdapter, _InMemoryCacheAdapter.InMemoryCacheAdapter, {
        appId: config.appId
      });
      this.cacheController = new _CacheController.CacheController(cacheControllerAdapter, config.appId);
    } // This auth cache stores the promises for each auth resolution.
    // The main benefit is to be able to reuse the same user / session token resolution.


    this.authCache = new _lruCache.default({
      max: 500,
      // 500 concurrent
      maxAge: 60 * 60 * 1000 // 1h

    }); // Initialize websocket server

    this.parseWebSocketServer = new _ParseWebSocketServer.ParseWebSocketServer(server, parseWebsocket => this._onConnect(parseWebsocket), config.websocketTimeout); // Initialize subscriber

    this.subscriber = _ParsePubSub.ParsePubSub.createSubscriber(config);
    this.subscriber.subscribe(_node.default.applicationId + 'afterSave');
    this.subscriber.subscribe(_node.default.applicationId + 'afterDelete'); // Register message handler for subscriber. When publisher get messages, it will publish message
    // to the subscribers and the handler will be called.

    this.subscriber.on('message', (channel, messageStr) => {
      _logger.default.verbose('Subscribe messsage %j', messageStr);

      let message;

      try {
        message = JSON.parse(messageStr);
      } catch (e) {
        _logger.default.error('unable to parse message', messageStr, e);

        return;
      }

      this._inflateParseObject(message);

      if (channel === _node.default.applicationId + 'afterSave') {
        this._onAfterSave(message);
      } else if (channel === _node.default.applicationId + 'afterDelete') {
        this._onAfterDelete(message);
      } else {
        _logger.default.error('Get message %s from unknown channel %j', message, channel);
      }
    }); // Initialize sessionToken cache

    this.sessionTokenCache = new _SessionTokenCache.SessionTokenCache(config.cacheTimeout); // hook up queryMiddleware

    this.queryMiddleware = config.queryMiddleware || [];
    this.loadRolesDelegate = config.loadRolesDelegate || defaultLoadRolesDelegate;
    console.log('ParseLiveQueryServer - this.loadRolesDelegate:', this.loadRolesDelegate);
  } // Message is the JSON object from publisher. Message.currentParseObject is the ParseObject JSON after changes.
  // Message.originalParseObject is the original ParseObject JSON.


  _inflateParseObject(message) {
    // Inflate merged object
    const currentParseObject = message.currentParseObject;

    _UsersRouter.default.removeHiddenProperties(currentParseObject);

    let className = currentParseObject.className;
    let parseObject = new _node.default.Object(className);

    parseObject._finishFetch(currentParseObject);

    message.currentParseObject = parseObject; // Inflate original object

    const originalParseObject = message.originalParseObject;

    if (originalParseObject) {
      _UsersRouter.default.removeHiddenProperties(originalParseObject);

      className = originalParseObject.className;
      parseObject = new _node.default.Object(className);

      parseObject._finishFetch(originalParseObject);

      message.originalParseObject = parseObject;
    }
  } // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.


  _onAfterDelete(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterDelete is triggered');

    const deletedParseObject = message.currentParseObject.toJSON();
    const classLevelPermissions = message.classLevelPermissions;
    const className = deletedParseObject.className;

    _logger.default.verbose('ClassName: %j | ObjectId: %s', className, deletedParseObject.id);

    _logger.default.verbose('Current client number : %d', this.clients.size);

    const classSubscriptions = this.subscriptions.get(className);

    if (typeof classSubscriptions === 'undefined') {
      _logger.default.debug('Can not find subscriptions under this class ' + className);

      return;
    }

    for (const subscription of classSubscriptions.values()) {
      const isSubscriptionMatched = this._matchesSubscription(deletedParseObject, subscription);

      if (!isSubscriptionMatched) {
        continue;
      }

      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);

        if (typeof client === 'undefined') {
          continue;
        }

        for (const requestId of requestIds) {
          const acl = message.currentParseObject.getACL(); // Check CLP

          const op = this._getCLPOperation(subscription.query);

          this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op).then(() => {
            // Check ACL
            return this._matchesACL(acl, client, requestId);
          }).then(isMatched => {
            if (!isMatched) {
              return null;
            }

            client.pushDelete(requestId, deletedParseObject);
          }).catch(error => {
            _logger.default.error('Matching ACL error : ', error);
          });
        }
      }
    }
  } // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.


  _onAfterSave(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterSave is triggered');

    let originalParseObject = null;

    if (message.originalParseObject) {
      originalParseObject = message.originalParseObject.toJSON();
    }

    const classLevelPermissions = message.classLevelPermissions;
    const currentParseObject = message.currentParseObject.toJSON();
    const className = currentParseObject.className;

    _logger.default.verbose('ClassName: %s | ObjectId: %s', className, currentParseObject.id);

    _logger.default.verbose('Current client number : %d', this.clients.size);

    const classSubscriptions = this.subscriptions.get(className);

    if (typeof classSubscriptions === 'undefined') {
      _logger.default.debug('Can not find subscriptions under this class ' + className);

      return;
    }

    for (const subscription of classSubscriptions.values()) {
      const isOriginalSubscriptionMatched = this._matchesSubscription(originalParseObject, subscription);

      const isCurrentSubscriptionMatched = this._matchesSubscription(currentParseObject, subscription);

      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);

        if (typeof client === 'undefined') {
          continue;
        }

        for (const requestId of requestIds) {
          // Set orignal ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL
          let originalACLCheckingPromise;

          if (!isOriginalSubscriptionMatched) {
            originalACLCheckingPromise = Promise.resolve(false);
          } else {
            let originalACL;

            if (message.originalParseObject) {
              originalACL = message.originalParseObject.getACL();
            }

            originalACLCheckingPromise = this._matchesACL(originalACL, client, requestId);
          } // Set current ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL


          let currentACLCheckingPromise;

          if (!isCurrentSubscriptionMatched) {
            currentACLCheckingPromise = Promise.resolve(false);
          } else {
            const currentACL = message.currentParseObject.getACL();
            currentACLCheckingPromise = this._matchesACL(currentACL, client, requestId);
          }

          const op = this._getCLPOperation(subscription.query);

          this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op).then(() => {
            return Promise.all([originalACLCheckingPromise, currentACLCheckingPromise]);
          }).then(([isOriginalMatched, isCurrentMatched]) => {
            _logger.default.verbose('Original %j | Current %j | Match: %s, %s, %s, %s | Query: %s', originalParseObject, currentParseObject, isOriginalSubscriptionMatched, isCurrentSubscriptionMatched, isOriginalMatched, isCurrentMatched, subscription.hash); // Decide event type


            let type;

            if (isOriginalMatched && isCurrentMatched) {
              type = 'Update';
            } else if (isOriginalMatched && !isCurrentMatched) {
              type = 'Leave';
            } else if (!isOriginalMatched && isCurrentMatched) {
              if (originalParseObject) {
                type = 'Enter';
              } else {
                type = 'Create';
              }
            } else {
              return null;
            }

            const functionName = 'push' + type;
            const ssToken = client.getSubscriptionInfo(requestId).sessionToken;
            this.sessionTokenCache.getUserId(ssToken).then(userId => {
              return this.cacheController.role.get(ssToken).then(cUser => {
                if (cUser) return cUser;
                return new _node.default.Query(_node.default.User).equalTo("objectId", userId).limit(10000).find({
                  useMasterKey: true
                }).then(user => {
                  if (!user || !user.length) return undefined;
                  this.cacheController.role.put(ssToken, user[0]);
                  return JSON.parse(JSON.stringify(user[0]));
                });
              });
            }).then(user => {
              let result = currentParseObject;
              (this.queryMiddleware || []).forEach(ware => result = ware(result.className, [result], {
                user: {
                  getTeams: () => user.teams
                }
              })[0]);
              client[functionName](requestId, result);
            });
          }, error => {
            _logger.default.error('Matching ACL error : ', error);
          });
        }
      }
    }
  }

  _onConnect(parseWebsocket) {
    parseWebsocket.on('message', request => {
      if (typeof request === 'string') {
        try {
          request = JSON.parse(request);
        } catch (e) {
          _logger.default.error('unable to parse request', request, e);

          return;
        }
      }

      _logger.default.verbose('Request: %j', request); // Check whether this request is a valid request, return error directly if not


      if (!_tv.default.validate(request, _RequestSchema.default['general']) || !_tv.default.validate(request, _RequestSchema.default[request.op])) {
        _Client.Client.pushError(parseWebsocket, 1, _tv.default.error.message);

        _logger.default.error('Connect message error %s', _tv.default.error.message);

        return;
      }

      switch (request.op) {
        case 'connect':
          this._handleConnect(parseWebsocket, request);

          break;

        case 'subscribe':
          this._handleSubscribe(parseWebsocket, request);

          break;

        case 'update':
          this._handleUpdateSubscription(parseWebsocket, request);

          break;

        case 'unsubscribe':
          this._handleUnsubscribe(parseWebsocket, request);

          break;

        default:
          _Client.Client.pushError(parseWebsocket, 3, 'Get unknown operation');

          _logger.default.error('Get unknown operation', request.op);

      }
    });
    parseWebsocket.on('disconnect', () => {
      _logger.default.info(`Client disconnect: ${parseWebsocket.clientId}`);

      const clientId = parseWebsocket.clientId;

      if (!this.clients.has(clientId)) {
        (0, _triggers.runLiveQueryEventHandlers)({
          event: 'ws_disconnect_error',
          clients: this.clients.size,
          subscriptions: this.subscriptions.size,
          error: `Unable to find client ${clientId}`
        });

        _logger.default.error(`Can not find client ${clientId} on disconnect`);

        return;
      } // Delete client


      const client = this.clients.get(clientId);
      this.clients.delete(clientId); // Delete client from subscriptions

      for (const [requestId, subscriptionInfo] of _lodash.default.entries(client.subscriptionInfos)) {
        const subscription = subscriptionInfo.subscription;
        subscription.deleteClientSubscription(clientId, requestId); // If there is no client which is subscribing this subscription, remove it from subscriptions

        const classSubscriptions = this.subscriptions.get(subscription.className);

        if (!subscription.hasSubscribingClient()) {
          classSubscriptions.delete(subscription.hash);
        } // If there is no subscriptions under this class, remove it from subscriptions


        if (classSubscriptions.size === 0) {
          this.subscriptions.delete(subscription.className);
        }
      }

      _logger.default.verbose('Current clients %d', this.clients.size);

      _logger.default.verbose('Current subscriptions %d', this.subscriptions.size);

      (0, _triggers.runLiveQueryEventHandlers)({
        event: 'ws_disconnect',
        clients: this.clients.size,
        subscriptions: this.subscriptions.size
      });
    });
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'ws_connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _matchesSubscription(parseObject, subscription) {
    // Object is undefined or null, not match
    if (!parseObject) {
      return false;
    }

    return (0, _QueryTools.matchesQuery)(parseObject, subscription.query);
  }

  getAuthForSessionToken(sessionToken) {
    if (!sessionToken) {
      return Promise.resolve({});
    }

    const fromCache = this.authCache.get(sessionToken);

    if (fromCache) {
      return fromCache;
    }

    const authPromise = (0, _Auth.getAuthForSessionToken)({
      cacheController: this.cacheController,
      sessionToken: sessionToken
    }).then(auth => {
      return {
        auth,
        userId: auth && auth.user && auth.user.id
      };
    }).catch(error => {
      // There was an error with the session token
      const result = {};

      if (error && error.code === _node.default.Error.INVALID_SESSION_TOKEN) {
        // Store a resolved promise with the error for 10 minutes
        result.error = error;
        this.authCache.set(sessionToken, Promise.resolve(result), 60 * 10 * 1000);
      } else {
        this.authCache.del(sessionToken);
      }

      return result;
    });
    this.authCache.set(sessionToken, authPromise);
    return authPromise;
  }

  async _matchesCLP(classLevelPermissions, object, client, requestId, op) {
    // try to match on user first, less expensive than with roles
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    const aclGroup = ['*'];
    let userId;

    if (typeof subscriptionInfo !== 'undefined') {
      const {
        userId
      } = await this.getAuthForSessionToken(subscriptionInfo.sessionToken);

      if (userId) {
        aclGroup.push(userId);
      }
    }

    try {
      await _SchemaController.default.validatePermission(classLevelPermissions, object.className, aclGroup, op);
      return true;
    } catch (e) {
      _logger.default.verbose(`Failed matching CLP for ${object.id} ${userId} ${e}`);

      return false;
    } // TODO: handle roles permissions
    // Object.keys(classLevelPermissions).forEach((key) => {
    //   const perm = classLevelPermissions[key];
    //   Object.keys(perm).forEach((key) => {
    //     if (key.indexOf('role'))
    //   });
    // })
    // // it's rejected here, check the roles
    // var rolesQuery = new Parse.Query(Parse.Role);
    // rolesQuery.equalTo("users", user);
    // return rolesQuery.find({useMasterKey:true});

  }

  _getCLPOperation(query) {
    return typeof query === 'object' && Object.keys(query).length == 1 && typeof query.objectId === 'string' ? 'get' : 'find';
  }

  async _verifyACL(acl, token) {
    if (!token) {
      return false;
    }

    const {
      auth,
      userId
    } = await this.getAuthForSessionToken(token); // Getting the session token failed
    // This means that no additional auth is available
    // At this point, just bail out as no additional visibility can be inferred.

    if (!auth || !userId) {
      return false;
    }

    const isSubscriptionSessionTokenMatched = acl.getReadAccess(userId);

    if (isSubscriptionSessionTokenMatched) {
      return true;
    } // Check if the user has any roles that match the ACL


    return Promise.resolve().then(async () => {
      // Resolve false right away if the acl doesn't have any roles
      const acl_has_roles = Object.keys(acl.permissionsById).some(key => key.startsWith('role:'));

      if (!acl_has_roles) {
        return false;
      }

      this.sessionTokenCache.getUserId(subscriptionSessionToken).then(userId => {
        // Pass along a null if there is no user id
        if (!userId) {
          return _node.default.Promise.as(null);
        }

        var user = new _node.default.User();
        user.id = userId;
        return user;
      }).then(user => {
        // Pass along an empty array (of roles) if no user
        if (!user) {
          return _node.default.Promise.as([]);
        }

        if (this.cacheController && this.cacheController.adapter && this.cacheController.adapter instanceof _RedisCacheAdapter.default) {
          return this.cacheController.role.get(user.id).then(roles => {
            if (roles != null) {
              console.log('LiveQuery: using roles from cache for user ' + user.id);
              return roles.map(role => role.replace(/^role:/, ''));
            }

            console.log('LiveQuery: loading roles from database as they\'re not cached for user ' + user.id);
            return this.loadRolesDelegate(user, this.cacheController).then(roles => {
              console.log(`LiveQuery: user: ${user.id}loaded roles:` + roles);
              this.cacheController.role.put(user.id, roles.map(role => 'role:' + role));
              return roles;
            });
          });
        } else {
          // fallback to direct query
          console.log('LiveQuery: fallback: loading roles from database for user ' + user.id);
          return this.loadRolesDelegate(user, this.cacheController);
        }
      }).then(roles => {
        // Finally, see if any of the user's roles allow them read access
        return !!~roles.findIndex(role => acl.getRoleReadAccess(role));
      }).catch(error => {
        console.log('LiveQuery: error:', error);
        return false;
      });
    });
  }

  async _matchesACL(acl, client, requestId) {
    // Return true directly if ACL isn't present, ACL is public read, or client has master key
    if (!acl || acl.getPublicReadAccess() || client.hasMasterKey) {
      return true;
    } // Check subscription sessionToken matches ACL first


    const subscriptionInfo = client.getSubscriptionInfo(requestId);

    if (typeof subscriptionInfo === 'undefined') {
      return false;
    }

    const subscriptionToken = subscriptionInfo.sessionToken;
    const clientSessionToken = client.sessionToken;

    if (await this._verifyACL(acl, subscriptionToken)) {
      return true;
    }

    if (await this._verifyACL(acl, clientSessionToken)) {
      return true;
    }

    return false;
  }

  _handleConnect(parseWebsocket, request) {
    if (!this._validateKeys(request, this.keyPairs)) {
      _Client.Client.pushError(parseWebsocket, 4, 'Key in request is not valid');

      _logger.default.error('Key in request is not valid');

      return;
    }

    const hasMasterKey = this._hasMasterKey(request, this.keyPairs);

    const clientId = (0, _uuid.default)();
    const client = new _Client.Client(clientId, parseWebsocket, hasMasterKey);
    parseWebsocket.clientId = clientId;
    this.clients.set(parseWebsocket.clientId, client);

    _logger.default.info(`Create new client: ${parseWebsocket.clientId}`);

    client.pushConnect();
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _hasMasterKey(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0 || !validKeyPairs.has('masterKey')) {
      return false;
    }

    if (!request || !request.hasOwnProperty('masterKey')) {
      return false;
    }

    return request.masterKey === validKeyPairs.get('masterKey');
  }

  _validateKeys(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0) {
      return true;
    }

    let isValid = false;

    for (const [key, secret] of validKeyPairs) {
      if (!request[key] || request[key] !== secret) {
        continue;
      }

      isValid = true;
      break;
    }

    return isValid;
  }

  _handleSubscribe(parseWebsocket, request) {
    // If we can not find this client, return error to client
    if (!parseWebsocket.hasOwnProperty('clientId')) {
      _Client.Client.pushError(parseWebsocket, 2, 'Can not find this client, make sure you connect to server before subscribing');

      _logger.default.error('Can not find this client, make sure you connect to server before subscribing');

      return;
    }

    const client = this.clients.get(parseWebsocket.clientId); // Get subscription from subscriptions, create one if necessary

    const subscriptionHash = (0, _QueryTools.queryHash)(request.query); // Add className to subscriptions if necessary

    const className = request.query.className;

    if (!this.subscriptions.has(className)) {
      this.subscriptions.set(className, new Map());
    }

    const classSubscriptions = this.subscriptions.get(className);
    let subscription;

    if (classSubscriptions.has(subscriptionHash)) {
      subscription = classSubscriptions.get(subscriptionHash);
    } else {
      subscription = new _Subscription.Subscription(className, request.query.where, subscriptionHash);
      classSubscriptions.set(subscriptionHash, subscription);
    } // Add subscriptionInfo to client


    const subscriptionInfo = {
      subscription: subscription
    }; // Add selected fields and sessionToken for this subscription if necessary

    if (request.query.fields) {
      subscriptionInfo.fields = request.query.fields;
    }

    if (request.sessionToken) {
      subscriptionInfo.sessionToken = request.sessionToken;
    }

    client.addSubscriptionInfo(request.requestId, subscriptionInfo); // Add clientId to subscription

    subscription.addClientSubscription(parseWebsocket.clientId, request.requestId);
    client.pushSubscribe(request.requestId);

    _logger.default.verbose(`Create client ${parseWebsocket.clientId} new subscription: ${request.requestId}`);

    _logger.default.verbose('Current client number: %d', this.clients.size);

    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'subscribe',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _handleUpdateSubscription(parseWebsocket, request) {
    this._handleUnsubscribe(parseWebsocket, request, false);

    this._handleSubscribe(parseWebsocket, request);
  }

  _handleUnsubscribe(parseWebsocket, request, notifyClient = true) {
    // If we can not find this client, return error to client
    if (!parseWebsocket.hasOwnProperty('clientId')) {
      _Client.Client.pushError(parseWebsocket, 2, 'Can not find this client, make sure you connect to server before unsubscribing');

      _logger.default.error('Can not find this client, make sure you connect to server before unsubscribing');

      return;
    }

    const requestId = request.requestId;
    const client = this.clients.get(parseWebsocket.clientId);

    if (typeof client === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find client with clientId ' + parseWebsocket.clientId + '. Make sure you connect to live query server before unsubscribing.');

      _logger.default.error('Can not find this client ' + parseWebsocket.clientId);

      return;
    }

    const subscriptionInfo = client.getSubscriptionInfo(requestId);

    if (typeof subscriptionInfo === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId + '. Make sure you subscribe to live query server before unsubscribing.');

      _logger.default.error('Can not find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId);

      return;
    } // Remove subscription from client


    client.deleteSubscriptionInfo(requestId); // Remove client from subscription

    const subscription = subscriptionInfo.subscription;
    const className = subscription.className;
    subscription.deleteClientSubscription(parseWebsocket.clientId, requestId); // If there is no client which is subscribing this subscription, remove it from subscriptions

    const classSubscriptions = this.subscriptions.get(className);

    if (!subscription.hasSubscribingClient()) {
      classSubscriptions.delete(subscription.hash);
    } // If there is no subscriptions under this class, remove it from subscriptions


    if (classSubscriptions.size === 0) {
      this.subscriptions.delete(className);
    }

    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'unsubscribe',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });

    if (!notifyClient) {
      return;
    }

    client.pushUnsubscribe(request.requestId);

    _logger.default.verbose(`Delete client: ${parseWebsocket.clientId} | subscription: ${request.requestId}`);
  }

}

exports.ParseLiveQueryServer = ParseLiveQueryServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9MaXZlUXVlcnkvUGFyc2VMaXZlUXVlcnlTZXJ2ZXIuanMiXSwibmFtZXMiOlsiZ2V0QWxsUm9sZXNOYW1lc0ZvclJvbGVJZHMiLCJyb2xlSURzIiwibmFtZXMiLCJxdWVyaWVkUm9sZXMiLCJpbnMiLCJmaWx0ZXIiLCJyb2xlSWQiLCJtYXAiLCJyb2xlIiwiUGFyc2UiLCJSb2xlIiwiaWQiLCJsZW5ndGgiLCJQcm9taXNlIiwicmVzb2x2ZSIsInF1ZXJ5IiwiUXVlcnkiLCJjb250YWluZWRJbiIsImxpbWl0IiwiZmluZCIsInVzZU1hc3RlcktleSIsInRoZW4iLCJyb2xlcyIsImlkcyIsInB1c2giLCJnZXROYW1lIiwiZGVmYXVsdExvYWRSb2xlc0RlbGVnYXRlIiwiYXV0aCIsImdldFVzZXJSb2xlcyIsIlBhcnNlTGl2ZVF1ZXJ5U2VydmVyIiwiY29uc3RydWN0b3IiLCJzZXJ2ZXIiLCJjb25maWciLCJjbGllbnRzIiwiTWFwIiwic3Vic2NyaXB0aW9ucyIsImFwcElkIiwiYXBwbGljYXRpb25JZCIsIm1hc3RlcktleSIsImtleVBhaXJzIiwia2V5IiwiT2JqZWN0Iiwia2V5cyIsInNldCIsImxvZ2dlciIsInZlcmJvc2UiLCJkaXNhYmxlU2luZ2xlSW5zdGFuY2UiLCJzZXJ2ZXJVUkwiLCJpbml0aWFsaXplIiwiamF2YVNjcmlwdEtleSIsImNhY2hlQ29udHJvbGxlciIsImNhY2hlQWRhcHRlciIsIlJlZGlzQ2FjaGVBZGFwdGVyIiwiY2FjaGVDb250cm9sbGVyQWRhcHRlciIsIkluTWVtb3J5Q2FjaGVBZGFwdGVyIiwiQ2FjaGVDb250cm9sbGVyIiwiYXV0aENhY2hlIiwiTFJVIiwibWF4IiwibWF4QWdlIiwicGFyc2VXZWJTb2NrZXRTZXJ2ZXIiLCJQYXJzZVdlYlNvY2tldFNlcnZlciIsInBhcnNlV2Vic29ja2V0IiwiX29uQ29ubmVjdCIsIndlYnNvY2tldFRpbWVvdXQiLCJzdWJzY3JpYmVyIiwiUGFyc2VQdWJTdWIiLCJjcmVhdGVTdWJzY3JpYmVyIiwic3Vic2NyaWJlIiwib24iLCJjaGFubmVsIiwibWVzc2FnZVN0ciIsIm1lc3NhZ2UiLCJKU09OIiwicGFyc2UiLCJlIiwiZXJyb3IiLCJfaW5mbGF0ZVBhcnNlT2JqZWN0IiwiX29uQWZ0ZXJTYXZlIiwiX29uQWZ0ZXJEZWxldGUiLCJzZXNzaW9uVG9rZW5DYWNoZSIsIlNlc3Npb25Ub2tlbkNhY2hlIiwiY2FjaGVUaW1lb3V0IiwicXVlcnlNaWRkbGV3YXJlIiwibG9hZFJvbGVzRGVsZWdhdGUiLCJjb25zb2xlIiwibG9nIiwiY3VycmVudFBhcnNlT2JqZWN0IiwiVXNlclJvdXRlciIsInJlbW92ZUhpZGRlblByb3BlcnRpZXMiLCJjbGFzc05hbWUiLCJwYXJzZU9iamVjdCIsIl9maW5pc2hGZXRjaCIsIm9yaWdpbmFsUGFyc2VPYmplY3QiLCJkZWxldGVkUGFyc2VPYmplY3QiLCJ0b0pTT04iLCJjbGFzc0xldmVsUGVybWlzc2lvbnMiLCJzaXplIiwiY2xhc3NTdWJzY3JpcHRpb25zIiwiZ2V0IiwiZGVidWciLCJzdWJzY3JpcHRpb24iLCJ2YWx1ZXMiLCJpc1N1YnNjcmlwdGlvbk1hdGNoZWQiLCJfbWF0Y2hlc1N1YnNjcmlwdGlvbiIsImNsaWVudElkIiwicmVxdWVzdElkcyIsIl8iLCJlbnRyaWVzIiwiY2xpZW50UmVxdWVzdElkcyIsImNsaWVudCIsInJlcXVlc3RJZCIsImFjbCIsImdldEFDTCIsIm9wIiwiX2dldENMUE9wZXJhdGlvbiIsIl9tYXRjaGVzQ0xQIiwiX21hdGNoZXNBQ0wiLCJpc01hdGNoZWQiLCJwdXNoRGVsZXRlIiwiY2F0Y2giLCJpc09yaWdpbmFsU3Vic2NyaXB0aW9uTWF0Y2hlZCIsImlzQ3VycmVudFN1YnNjcmlwdGlvbk1hdGNoZWQiLCJvcmlnaW5hbEFDTENoZWNraW5nUHJvbWlzZSIsIm9yaWdpbmFsQUNMIiwiY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSIsImN1cnJlbnRBQ0wiLCJhbGwiLCJpc09yaWdpbmFsTWF0Y2hlZCIsImlzQ3VycmVudE1hdGNoZWQiLCJoYXNoIiwidHlwZSIsImZ1bmN0aW9uTmFtZSIsInNzVG9rZW4iLCJnZXRTdWJzY3JpcHRpb25JbmZvIiwic2Vzc2lvblRva2VuIiwiZ2V0VXNlcklkIiwidXNlcklkIiwiY1VzZXIiLCJVc2VyIiwiZXF1YWxUbyIsInVzZXIiLCJ1bmRlZmluZWQiLCJwdXQiLCJzdHJpbmdpZnkiLCJyZXN1bHQiLCJmb3JFYWNoIiwid2FyZSIsImdldFRlYW1zIiwidGVhbXMiLCJyZXF1ZXN0IiwidHY0IiwidmFsaWRhdGUiLCJSZXF1ZXN0U2NoZW1hIiwiQ2xpZW50IiwicHVzaEVycm9yIiwiX2hhbmRsZUNvbm5lY3QiLCJfaGFuZGxlU3Vic2NyaWJlIiwiX2hhbmRsZVVwZGF0ZVN1YnNjcmlwdGlvbiIsIl9oYW5kbGVVbnN1YnNjcmliZSIsImluZm8iLCJoYXMiLCJldmVudCIsImRlbGV0ZSIsInN1YnNjcmlwdGlvbkluZm8iLCJzdWJzY3JpcHRpb25JbmZvcyIsImRlbGV0ZUNsaWVudFN1YnNjcmlwdGlvbiIsImhhc1N1YnNjcmliaW5nQ2xpZW50IiwiZ2V0QXV0aEZvclNlc3Npb25Ub2tlbiIsImZyb21DYWNoZSIsImF1dGhQcm9taXNlIiwiY29kZSIsIkVycm9yIiwiSU5WQUxJRF9TRVNTSU9OX1RPS0VOIiwiZGVsIiwib2JqZWN0IiwiYWNsR3JvdXAiLCJTY2hlbWFDb250cm9sbGVyIiwidmFsaWRhdGVQZXJtaXNzaW9uIiwib2JqZWN0SWQiLCJfdmVyaWZ5QUNMIiwidG9rZW4iLCJpc1N1YnNjcmlwdGlvblNlc3Npb25Ub2tlbk1hdGNoZWQiLCJnZXRSZWFkQWNjZXNzIiwiYWNsX2hhc19yb2xlcyIsInBlcm1pc3Npb25zQnlJZCIsInNvbWUiLCJzdGFydHNXaXRoIiwic3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuIiwiYXMiLCJhZGFwdGVyIiwicmVwbGFjZSIsImZpbmRJbmRleCIsImdldFJvbGVSZWFkQWNjZXNzIiwiZ2V0UHVibGljUmVhZEFjY2VzcyIsImhhc01hc3RlcktleSIsInN1YnNjcmlwdGlvblRva2VuIiwiY2xpZW50U2Vzc2lvblRva2VuIiwiX3ZhbGlkYXRlS2V5cyIsIl9oYXNNYXN0ZXJLZXkiLCJwdXNoQ29ubmVjdCIsInZhbGlkS2V5UGFpcnMiLCJoYXNPd25Qcm9wZXJ0eSIsImlzVmFsaWQiLCJzZWNyZXQiLCJzdWJzY3JpcHRpb25IYXNoIiwiU3Vic2NyaXB0aW9uIiwid2hlcmUiLCJmaWVsZHMiLCJhZGRTdWJzY3JpcHRpb25JbmZvIiwiYWRkQ2xpZW50U3Vic2NyaXB0aW9uIiwicHVzaFN1YnNjcmliZSIsIm5vdGlmeUNsaWVudCIsImRlbGV0ZVN1YnNjcmlwdGlvbkluZm8iLCJwdXNoVW5zdWJzY3JpYmUiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFBQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7OztBQUdBLFNBQVNBLDBCQUFULENBQW9DQyxPQUFwQyxFQUFrREMsS0FBbEQsRUFBOERDLFlBQTlELEVBQWlGO0FBQy9FLFFBQU1DLEdBQUcsR0FBR0gsT0FBTyxDQUFDSSxNQUFSLENBQWdCQyxNQUFELElBQVk7QUFDckMsV0FBT0gsWUFBWSxDQUFDRyxNQUFELENBQVosS0FBeUIsSUFBaEM7QUFDRCxHQUZXLEVBRVRDLEdBRlMsQ0FFSkQsTUFBRCxJQUFZO0FBQ2pCSCxJQUFBQSxZQUFZLENBQUNHLE1BQUQsQ0FBWixHQUF1QixJQUF2QjtBQUNBLFVBQU1FLElBQUksR0FBRyxJQUFJQyxjQUFNQyxJQUFWLEVBQWI7QUFDQUYsSUFBQUEsSUFBSSxDQUFDRyxFQUFMLEdBQVVMLE1BQVY7QUFDQSxXQUFPRSxJQUFQO0FBQ0QsR0FQVyxDQUFaOztBQVFBLE1BQUlKLEdBQUcsQ0FBQ1EsTUFBSixLQUFlLENBQW5CLEVBQXNCO0FBQ3BCLFdBQU9DLE9BQU8sQ0FBQ0MsT0FBUixDQUFn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U0FBL0I7QUFDQVcsSUFBQUEsWUFBWSxDQUFDaUUsd0JBQWIsQ0FBc0N4RyxjQUFjLENBQUMyQyxRQUFyRCxFQUErRE0sU0FBL0QsRUFwREssQ0FxREw7O0FBQ0EsVUFBTWIsa0JBQWtCLEdBQUcsS0FBSy9ELGFBQUwsQ0FBbUJnRSxHQUFuQixDQUF1QlQsU0FBdkIsQ0FBM0I7O0FBQ0EsUUFBSSxDQUFDVyxZQUFZLENBQUNrRSxvQkFBYixFQUFMLEVBQTBDO0FBQ3hDckUsTUFBQUEsa0JBQWtCLENBQUNpRSxNQUFuQixDQUEwQjlELFlBQVksQ0FBQzZCLElBQXZDO0FBQ0QsS0F6REksQ0EwREw7OztBQUNBLFFBQUloQyxrQkFBa0IsQ0FBQ0QsSUFBbkIsS0FBNEIsQ0FBaEMsRUFBbUM7QUFDakMsV0FBSzlELGFBQUwsQ0FBbUJnSSxNQUFuQixDQUEwQnpFLFNBQTFCO0FBQ0Q7O0FBQ0QsNkNBQTBCO0FBQ3hCd0UsTUFBQUEsS0FBSyxFQUFFLGFBRGlCO0FBRXhCakksTUFBQUEsT0FBTyxFQUFFLEtBQUtBLE9BQUwsQ0FBYWdFLElBRkU7QUFHeEI5RCxNQUFBQSxhQUFhLEVBQUUsS0FBS0EsYUFBTCxDQUFtQjhEO0FBSFYsS0FBMUI7O0FBTUEsUUFBSSxDQUFDbUgsWUFBTCxFQUFtQjtBQUNqQjtBQUNEOztBQUVEdEcsSUFBQUEsTUFBTSxDQUFDd0csZUFBUCxDQUF1QmhFLE9BQU8sQ0FBQ3ZDLFNBQS9COztBQUVBbkUsb0JBQU9DLE9BQVAsQ0FDRyxrQkFBaUJpQixjQUFjLENBQUMyQyxRQUFTLG9CQUN4QzZDLE9BQU8sQ0FBQ3ZDLFNBQ1QsRUFISDtBQUtEOztBQXR6QndCIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR2NCBmcm9tICd0djQnO1xuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgU3Vic2NyaXB0aW9uIH0gZnJvbSAnLi9TdWJzY3JpcHRpb24nO1xuaW1wb3J0IHsgQ2xpZW50IH0gZnJvbSAnLi9DbGllbnQnO1xuaW1wb3J0IHsgUGFyc2VXZWJTb2NrZXRTZXJ2ZXIgfSBmcm9tICcuL1BhcnNlV2ViU29ja2V0U2VydmVyJztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi4vbG9nZ2VyJztcbmltcG9ydCBSZXF1ZXN0U2NoZW1hIGZyb20gJy4vUmVxdWVzdFNjaGVtYSc7XG5pbXBvcnQgeyBtYXRjaGVzUXVlcnksIHF1ZXJ5SGFzaCB9IGZyb20gJy4vUXVlcnlUb29scyc7XG5pbXBvcnQgeyBQYXJzZVB1YlN1YiB9IGZyb20gJy4vUGFyc2VQdWJTdWInO1xuaW1wb3J0IFNjaGVtYUNvbnRyb2xsZXIgZnJvbSAnLi4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcic7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IHV1aWQgZnJvbSAndXVpZCc7XG5pbXBvcnQgeyBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIH0gZnJvbSAnLi4vdHJpZ2dlcnMnO1xuaW1wb3J0IHsgZ2V0QXV0aEZvclNlc3Npb25Ub2tlbiwgQXV0aCB9IGZyb20gJy4uL0F1dGgnO1xuaW1wb3J0IHsgZ2V0Q2FjaGVDb250cm9sbGVyIH0gZnJvbSAnLi4vQ29udHJvbGxlcnMnO1xuaW1wb3J0IExSVSBmcm9tICdscnUtY2FjaGUnO1xuaW1wb3J0IFVzZXJSb3V0ZXIgZnJvbSAnLi4vUm91dGVycy9Vc2Vyc1JvdXRlcic7XG5pbXBvcnQgeyBsb2FkQWRhcHRlciB9ICAgICAgICAgIGZyb20gJy4uL0FkYXB0ZXJzL0FkYXB0ZXJMb2FkZXInO1xuaW1wb3J0IHsgSW5NZW1vcnlDYWNoZUFkYXB0ZXIgfSBmcm9tICcuLi9BZGFwdGVycy9DYWNoZS9Jbk1lbW9yeUNhY2hlQWRhcHRlcic7XG5pbXBvcnQgeyBDYWNoZUNvbnRyb2xsZXIgfSAgICAgIGZyb20gJy4uL0NvbnRyb2xsZXJzL0NhY2hlQ29udHJvbGxlcic7XG5pbXBvcnQgUmVkaXNDYWNoZUFkYXB0ZXIgICAgICAgIGZyb20gJy4uL0FkYXB0ZXJzL0NhY2hlL1JlZGlzQ2FjaGVBZGFwdGVyJztcbmltcG9ydCB7IFNlc3Npb25Ub2tlbkNhY2hlIH0gZnJvbSAnLi9TZXNzaW9uVG9rZW5DYWNoZSc7XG5cblxuZnVuY3Rpb24gZ2V0QWxsUm9sZXNOYW1lc0ZvclJvbGVJZHMocm9sZUlEczogYW55LCBuYW1lczogYW55LCBxdWVyaWVkUm9sZXM6IGFueSkge1xuICBjb25zdCBpbnMgPSByb2xlSURzLmZpbHRlcigocm9sZUlkKSA9PiB7XG4gICAgcmV0dXJuIHF1ZXJpZWRSb2xlc1tyb2xlSWRdICE9PSB0cnVlO1xuICB9KS5tYXAoKHJvbGVJZCkgPT4ge1xuICAgIHF1ZXJpZWRSb2xlc1tyb2xlSWRdID0gdHJ1ZTtcbiAgICBjb25zdCByb2xlID0gbmV3IFBhcnNlLlJvbGUoKTtcbiAgICByb2xlLmlkID0gcm9sZUlkO1xuICAgIHJldHVybiByb2xlO1xuICB9KTtcbiAgaWYgKGlucy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFsuLi5uYW1lc10pO1xuICB9XG5cbiAgY29uc3QgcXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoUGFyc2UuUm9sZSk7XG4gIHF1ZXJ5LmNvbnRhaW5lZEluKCdyb2xlcycsIGlucyk7XG4gIHF1ZXJ5LmxpbWl0KDEwMDAwKTtcbiAgcmV0dXJuIHF1ZXJ5LmZpbmQoe3VzZU1hc3RlcktleTogdHJ1ZX0pLnRoZW4oKHJvbGVzKSA9PiB7XG4gICAgaWYgKCFyb2xlcy5sZW5ndGgpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUobmFtZXMpO1xuICAgIH1cblxuICAgIGNvbnN0IGlkcyA9IFtdO1xuICAgIHJvbGVzLm1hcCgocm9sZSkgPT4ge1xuICAgICAgbmFtZXMucHVzaChyb2xlLmdldE5hbWUoKSk7XG4gICAgICBpZHMucHVzaChyb2xlLmlkKTtcbiAgICAgIHF1ZXJpZWRSb2xlc1tyb2xlLmlkXSA9IHF1ZXJpZWRSb2xlc1tyb2xlLmlkXSB8fCBmYWxzZTtcbiAgICB9KTtcblxuICAgIHJldHVybiBnZXRBbGxSb2xlc05hbWVzRm9yUm9sZUlkcyhpZHMsIG5hbWVzLCBxdWVyaWVkUm9sZXMpO1xuICB9KS50aGVuKChuYW1lcykgPT4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoWy4uLm5hbWVzXSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0TG9hZFJvbGVzRGVsZWdhdGUoYXV0aDogYW55KSB7XG4gIHJldHVybiBhdXRoLmdldFVzZXJSb2xlcygpO1xufVxuXG5jbGFzcyBQYXJzZUxpdmVRdWVyeVNlcnZlciB7XG4gIGNsaWVudHM6IE1hcDtcbiAgLy8gY2xhc3NOYW1lIC0+IChxdWVyeUhhc2ggLT4gc3Vic2NyaXB0aW9uKVxuICBzdWJzY3JpcHRpb25zOiBPYmplY3Q7XG4gIHBhcnNlV2ViU29ja2V0U2VydmVyOiBPYmplY3Q7XG4gIGtleVBhaXJzOiBhbnk7XG4gIC8vIFRoZSBzdWJzY3JpYmVyIHdlIHVzZSB0byBnZXQgb2JqZWN0IHVwZGF0ZSBmcm9tIHB1Ymxpc2hlclxuICBzdWJzY3JpYmVyOiBPYmplY3Q7XG4gIGNhY2hlQ29udHJvbGxlcjogYW55O1xuXG4gIGNvbnN0cnVjdG9yKHNlcnZlcjogYW55LCBjb25maWc6IGFueSA9IHt9KSB7XG4gICAgdGhpcy5zZXJ2ZXIgPSBzZXJ2ZXI7XG4gICAgdGhpcy5jbGllbnRzID0gbmV3IE1hcCgpO1xuICAgIHRoaXMuc3Vic2NyaXB0aW9ucyA9IG5ldyBNYXAoKTtcblxuICAgIGNvbmZpZy5hcHBJZCA9IGNvbmZpZy5hcHBJZCB8fCBQYXJzZS5hcHBsaWNhdGlvbklkO1xuICAgIGNvbmZpZy5tYXN0ZXJLZXkgPSBjb25maWcubWFzdGVyS2V5IHx8IFBhcnNlLm1hc3RlcktleTtcblxuICAgIC8vIFN0b3JlIGtleXMsIGNvbnZlcnQgb2JqIHRvIG1hcFxuICAgIGNvbnN0IGtleVBhaXJzID0gY29uZmlnLmtleVBhaXJzIHx8IHt9O1xuICAgIHRoaXMua2V5UGFpcnMgPSBuZXcgTWFwKCk7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoa2V5UGFpcnMpKSB7XG4gICAgICB0aGlzLmtleVBhaXJzLnNldChrZXksIGtleVBhaXJzW2tleV0pO1xuICAgIH1cbiAgICBsb2dnZXIudmVyYm9zZSgnU3VwcG9ydCBrZXkgcGFpcnMnLCB0aGlzLmtleVBhaXJzKTtcblxuICAgIC8vIEluaXRpYWxpemUgUGFyc2VcbiAgICBQYXJzZS5PYmplY3QuZGlzYWJsZVNpbmdsZUluc3RhbmNlKCk7XG4gICAgY29uc3Qgc2VydmVyVVJMID0gY29uZmlnLnNlcnZlclVSTCB8fCBQYXJzZS5zZXJ2ZXJVUkw7XG4gICAgUGFyc2Uuc2VydmVyVVJMID0gc2VydmVyVVJMO1xuICAgIFBhcnNlLmluaXRpYWxpemUoY29uZmlnLmFwcElkLCBQYXJzZS5qYXZhU2NyaXB0S2V5LCBjb25maWcubWFzdGVyS2V5KTtcblxuICAgIC8vIFRoZSBjYWNoZSBjb250cm9sbGVyIGlzIGEgcHJvcGVyIGNhY2hlIGNvbnRyb2xsZXJcbiAgICAvLyB3aXRoIGFjY2VzcyB0byBVc2VyIGFuZCBSb2xlc1xuICAgIHRoaXMuY2FjaGVDb250cm9sbGVyID0gZ2V0Q2FjaGVDb250cm9sbGVyKGNvbmZpZyk7XG5cbiAgICAvLyBJbml0aWFsaXplIGNhY2hlXG4gICAgaWYgKGNvbmZpZy5jYWNoZUFkYXB0ZXIgaW5zdGFuY2VvZiBSZWRpc0NhY2hlQWRhcHRlcikge1xuICAgICAgY29uc3QgY2FjaGVDb250cm9sbGVyQWRhcHRlciA9IGxvYWRBZGFwdGVyKGNvbmZpZy5jYWNoZUFkYXB0ZXIsIEluTWVtb3J5Q2FjaGVBZGFwdGVyLCB7YXBwSWQ6IGNvbmZpZy5hcHBJZH0pO1xuICAgICAgdGhpcy5jYWNoZUNvbnRyb2xsZXIgPSBuZXcgQ2FjaGVDb250cm9sbGVyKGNhY2hlQ29udHJvbGxlckFkYXB0ZXIsIGNvbmZpZy5hcHBJZCk7XG4gICAgfVxuICAgIC8vIFRoaXMgYXV0aCBjYWNoZSBzdG9yZXMgdGhlIHByb21pc2VzIGZvciBlYWNoIGF1dGggcmVzb2x1dGlvbi5cbiAgICAvLyBUaGUgbWFpbiBiZW5lZml0IGlzIHRvIGJlIGFibGUgdG8gcmV1c2UgdGhlIHNhbWUgdXNlciAvIHNlc3Npb24gdG9rZW4gcmVzb2x1dGlvbi5cbiAgICB0aGlzLmF1dGhDYWNoZSA9IG5ldyBMUlUoe1xuICAgICAgbWF4OiA1MDAsIC8vIDUwMCBjb25jdXJyZW50XG4gICAgICBtYXhBZ2U6IDYwICogNjAgKiAxMDAwLCAvLyAxaFxuICAgIH0pO1xuICAgIC8vIEluaXRpYWxpemUgd2Vic29ja2V0IHNlcnZlclxuICAgIHRoaXMucGFyc2VXZWJTb2NrZXRTZXJ2ZXIgPSBuZXcgUGFyc2VXZWJTb2NrZXRTZXJ2ZXIoXG4gICAgICBzZXJ2ZXIsXG4gICAgICBwYXJzZVdlYnNvY2tldCA9PiB0aGlzLl9vbkNvbm5lY3QocGFyc2VXZWJzb2NrZXQpLFxuICAgICAgY29uZmlnLndlYnNvY2tldFRpbWVvdXRcbiAgICApO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBzdWJzY3JpYmVyXG4gICAgdGhpcy5zdWJzY3JpYmVyID0gUGFyc2VQdWJTdWIuY3JlYXRlU3Vic2NyaWJlcihjb25maWcpO1xuICAgIHRoaXMuc3Vic2NyaWJlci5zdWJzY3JpYmUoUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUnKTtcbiAgICB0aGlzLnN1YnNjcmliZXIuc3Vic2NyaWJlKFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJEZWxldGUnKTtcbiAgICAvLyBSZWdpc3RlciBtZXNzYWdlIGhhbmRsZXIgZm9yIHN1YnNjcmliZXIuIFdoZW4gcHVibGlzaGVyIGdldCBtZXNzYWdlcywgaXQgd2lsbCBwdWJsaXNoIG1lc3NhZ2VcbiAgICAvLyB0byB0aGUgc3Vic2NyaWJlcnMgYW5kIHRoZSBoYW5kbGVyIHdpbGwgYmUgY2FsbGVkLlxuICAgIHRoaXMuc3Vic2NyaWJlci5vbignbWVzc2FnZScsIChjaGFubmVsLCBtZXNzYWdlU3RyKSA9PiB7XG4gICAgICBsb2dnZXIudmVyYm9zZSgnU3Vic2NyaWJlIG1lc3NzYWdlICVqJywgbWVzc2FnZVN0cik7XG4gICAgICBsZXQgbWVzc2FnZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIG1lc3NhZ2UgPSBKU09OLnBhcnNlKG1lc3NhZ2VTdHIpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ3VuYWJsZSB0byBwYXJzZSBtZXNzYWdlJywgbWVzc2FnZVN0ciwgZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMuX2luZmxhdGVQYXJzZU9iamVjdChtZXNzYWdlKTtcbiAgICAgIGlmIChjaGFubmVsID09PSBQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyU2F2ZScpIHtcbiAgICAgICAgdGhpcy5fb25BZnRlclNhdmUobWVzc2FnZSk7XG4gICAgICB9IGVsc2UgaWYgKGNoYW5uZWwgPT09IFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJEZWxldGUnKSB7XG4gICAgICAgIHRoaXMuX29uQWZ0ZXJEZWxldGUobWVzc2FnZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICAgJ0dldCBtZXNzYWdlICVzIGZyb20gdW5rbm93biBjaGFubmVsICVqJyxcbiAgICAgICAgICBtZXNzYWdlLFxuICAgICAgICAgIGNoYW5uZWxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvLyBJbml0aWFsaXplIHNlc3Npb25Ub2tlbiBjYWNoZVxuICAgIHRoaXMuc2Vzc2lvblRva2VuQ2FjaGUgPSBuZXcgU2Vzc2lvblRva2VuQ2FjaGUoY29uZmlnLmNhY2hlVGltZW91dCk7XG5cbiAgICAvLyBob29rIHVwIHF1ZXJ5TWlkZGxld2FyZVxuICAgIHRoaXMucXVlcnlNaWRkbGV3YXJlID0gY29uZmlnLnF1ZXJ5TWlkZGxld2FyZSB8fCBbXTtcblxuICAgIHRoaXMubG9hZFJvbGVzRGVsZWdhdGUgPSBjb25maWcubG9hZFJvbGVzRGVsZWdhdGUgfHwgZGVmYXVsdExvYWRSb2xlc0RlbGVnYXRlO1xuXG4gICAgY29uc29sZS5sb2coJ1BhcnNlTGl2ZVF1ZXJ5U2VydmVyIC0gdGhpcy5sb2FkUm9sZXNEZWxlZ2F0ZTonLCB0aGlzLmxvYWRSb2xlc0RlbGVnYXRlKTtcblxuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBKU09OIGFmdGVyIGNoYW5nZXMuXG4gIC8vIE1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCBpcyB0aGUgb3JpZ2luYWwgUGFyc2VPYmplY3QgSlNPTi5cbiAgX2luZmxhdGVQYXJzZU9iamVjdChtZXNzYWdlOiBhbnkpOiB2b2lkIHtcbiAgICAvLyBJbmZsYXRlIG1lcmdlZCBvYmplY3RcbiAgICBjb25zdCBjdXJyZW50UGFyc2VPYmplY3QgPSBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdDtcbiAgICBVc2VyUm91dGVyLnJlbW92ZUhpZGRlblByb3BlcnRpZXMoY3VycmVudFBhcnNlT2JqZWN0KTtcbiAgICBsZXQgY2xhc3NOYW1lID0gY3VycmVudFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICBsZXQgcGFyc2VPYmplY3QgPSBuZXcgUGFyc2UuT2JqZWN0KGNsYXNzTmFtZSk7XG4gICAgcGFyc2VPYmplY3QuX2ZpbmlzaEZldGNoKGN1cnJlbnRQYXJzZU9iamVjdCk7XG4gICAgbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QgPSBwYXJzZU9iamVjdDtcbiAgICAvLyBJbmZsYXRlIG9yaWdpbmFsIG9iamVjdFxuICAgIGNvbnN0IG9yaWdpbmFsUGFyc2VPYmplY3QgPSBtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3Q7XG4gICAgaWYgKG9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICAgIFVzZXJSb3V0ZXIucmVtb3ZlSGlkZGVuUHJvcGVydGllcyhvcmlnaW5hbFBhcnNlT2JqZWN0KTtcbiAgICAgIGNsYXNzTmFtZSA9IG9yaWdpbmFsUGFyc2VPYmplY3QuY2xhc3NOYW1lO1xuICAgICAgcGFyc2VPYmplY3QgPSBuZXcgUGFyc2UuT2JqZWN0KGNsYXNzTmFtZSk7XG4gICAgICBwYXJzZU9iamVjdC5fZmluaXNoRmV0Y2gob3JpZ2luYWxQYXJzZU9iamVjdCk7XG4gICAgICBtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgPSBwYXJzZU9iamVjdDtcbiAgICB9XG4gIH1cblxuICAvLyBNZXNzYWdlIGlzIHRoZSBKU09OIG9iamVjdCBmcm9tIHB1Ymxpc2hlciBhZnRlciBpbmZsYXRlZC4gTWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QgaXMgdGhlIFBhcnNlT2JqZWN0IGFmdGVyIGNoYW5nZXMuXG4gIC8vIE1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCBpcyB0aGUgb3JpZ2luYWwgUGFyc2VPYmplY3QuXG4gIF9vbkFmdGVyRGVsZXRlKG1lc3NhZ2U6IGFueSk6IHZvaWQge1xuICAgIGxvZ2dlci52ZXJib3NlKFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJEZWxldGUgaXMgdHJpZ2dlcmVkJyk7XG5cbiAgICBjb25zdCBkZWxldGVkUGFyc2VPYmplY3QgPSBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdC50b0pTT04oKTtcbiAgICBjb25zdCBjbGFzc0xldmVsUGVybWlzc2lvbnMgPSBtZXNzYWdlLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucztcbiAgICBjb25zdCBjbGFzc05hbWUgPSBkZWxldGVkUGFyc2VPYmplY3QuY2xhc3NOYW1lO1xuICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgJ0NsYXNzTmFtZTogJWogfCBPYmplY3RJZDogJXMnLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgZGVsZXRlZFBhcnNlT2JqZWN0LmlkXG4gICAgKTtcbiAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBjbGllbnQgbnVtYmVyIDogJWQnLCB0aGlzLmNsaWVudHMuc2l6ZSk7XG5cbiAgICBjb25zdCBjbGFzc1N1YnNjcmlwdGlvbnMgPSB0aGlzLnN1YnNjcmlwdGlvbnMuZ2V0KGNsYXNzTmFtZSk7XG4gICAgaWYgKHR5cGVvZiBjbGFzc1N1YnNjcmlwdGlvbnMgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBsb2dnZXIuZGVidWcoJ0NhbiBub3QgZmluZCBzdWJzY3JpcHRpb25zIHVuZGVyIHRoaXMgY2xhc3MgJyArIGNsYXNzTmFtZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3Qgc3Vic2NyaXB0aW9uIG9mIGNsYXNzU3Vic2NyaXB0aW9ucy52YWx1ZXMoKSkge1xuICAgICAgY29uc3QgaXNTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihcbiAgICAgICAgZGVsZXRlZFBhcnNlT2JqZWN0LFxuICAgICAgICBzdWJzY3JpcHRpb25cbiAgICAgICk7XG4gICAgICBpZiAoIWlzU3Vic2NyaXB0aW9uTWF0Y2hlZCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgW2NsaWVudElkLCByZXF1ZXN0SWRzXSBvZiBfLmVudHJpZXMoXG4gICAgICAgIHN1YnNjcmlwdGlvbi5jbGllbnRSZXF1ZXN0SWRzXG4gICAgICApKSB7XG4gICAgICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuY2xpZW50cy5nZXQoY2xpZW50SWQpO1xuICAgICAgICBpZiAodHlwZW9mIGNsaWVudCA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IHJlcXVlc3RJZCBvZiByZXF1ZXN0SWRzKSB7XG4gICAgICAgICAgY29uc3QgYWNsID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QuZ2V0QUNMKCk7XG4gICAgICAgICAgLy8gQ2hlY2sgQ0xQXG4gICAgICAgICAgY29uc3Qgb3AgPSB0aGlzLl9nZXRDTFBPcGVyYXRpb24oc3Vic2NyaXB0aW9uLnF1ZXJ5KTtcbiAgICAgICAgICB0aGlzLl9tYXRjaGVzQ0xQKFxuICAgICAgICAgICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICAgICAgICAgICAgbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QsXG4gICAgICAgICAgICBjbGllbnQsXG4gICAgICAgICAgICByZXF1ZXN0SWQsXG4gICAgICAgICAgICBvcFxuICAgICAgICAgIClcbiAgICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgICAgLy8gQ2hlY2sgQUNMXG4gICAgICAgICAgICAgIHJldHVybiB0aGlzLl9tYXRjaGVzQUNMKGFjbCwgY2xpZW50LCByZXF1ZXN0SWQpO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC50aGVuKGlzTWF0Y2hlZCA9PiB7XG4gICAgICAgICAgICAgIGlmICghaXNNYXRjaGVkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgY2xpZW50LnB1c2hEZWxldGUocmVxdWVzdElkLCBkZWxldGVkUGFyc2VPYmplY3QpO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAgIGxvZ2dlci5lcnJvcignTWF0Y2hpbmcgQUNMIGVycm9yIDogJywgZXJyb3IpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBNZXNzYWdlIGlzIHRoZSBKU09OIG9iamVjdCBmcm9tIHB1Ymxpc2hlciBhZnRlciBpbmZsYXRlZC4gTWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QgaXMgdGhlIFBhcnNlT2JqZWN0IGFmdGVyIGNoYW5nZXMuXG4gIC8vIE1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCBpcyB0aGUgb3JpZ2luYWwgUGFyc2VPYmplY3QuXG4gIF9vbkFmdGVyU2F2ZShtZXNzYWdlOiBhbnkpOiB2b2lkIHtcbiAgICBsb2dnZXIudmVyYm9zZShQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyU2F2ZSBpcyB0cmlnZ2VyZWQnKTtcblxuICAgIGxldCBvcmlnaW5hbFBhcnNlT2JqZWN0ID0gbnVsbDtcbiAgICBpZiAobWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0LnRvSlNPTigpO1xuICAgIH1cbiAgICBjb25zdCBjbGFzc0xldmVsUGVybWlzc2lvbnMgPSBtZXNzYWdlLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucztcbiAgICBjb25zdCBjdXJyZW50UGFyc2VPYmplY3QgPSBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdC50b0pTT04oKTtcbiAgICBjb25zdCBjbGFzc05hbWUgPSBjdXJyZW50UGFyc2VPYmplY3QuY2xhc3NOYW1lO1xuICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgJ0NsYXNzTmFtZTogJXMgfCBPYmplY3RJZDogJXMnLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgY3VycmVudFBhcnNlT2JqZWN0LmlkXG4gICAgKTtcbiAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBjbGllbnQgbnVtYmVyIDogJWQnLCB0aGlzLmNsaWVudHMuc2l6ZSk7XG5cbiAgICBjb25zdCBjbGFzc1N1YnNjcmlwdGlvbnMgPSB0aGlzLnN1YnNjcmlwdGlvbnMuZ2V0KGNsYXNzTmFtZSk7XG4gICAgaWYgKHR5cGVvZiBjbGFzc1N1YnNjcmlwdGlvbnMgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBsb2dnZXIuZGVidWcoJ0NhbiBub3QgZmluZCBzdWJzY3JpcHRpb25zIHVuZGVyIHRoaXMgY2xhc3MgJyArIGNsYXNzTmFtZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3Qgc3Vic2NyaXB0aW9uIG9mIGNsYXNzU3Vic2NyaXB0aW9ucy52YWx1ZXMoKSkge1xuICAgICAgY29uc3QgaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQgPSB0aGlzLl9tYXRjaGVzU3Vic2NyaXB0aW9uKFxuICAgICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgICBzdWJzY3JpcHRpb25cbiAgICAgICk7XG4gICAgICBjb25zdCBpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihcbiAgICAgICAgY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICBzdWJzY3JpcHRpb25cbiAgICAgICk7XG4gICAgICBmb3IgKGNvbnN0IFtjbGllbnRJZCwgcmVxdWVzdElkc10gb2YgXy5lbnRyaWVzKFxuICAgICAgICBzdWJzY3JpcHRpb24uY2xpZW50UmVxdWVzdElkc1xuICAgICAgKSkge1xuICAgICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KGNsaWVudElkKTtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCByZXF1ZXN0SWQgb2YgcmVxdWVzdElkcykge1xuICAgICAgICAgIC8vIFNldCBvcmlnbmFsIFBhcnNlT2JqZWN0IEFDTCBjaGVja2luZyBwcm9taXNlLCBpZiB0aGUgb2JqZWN0IGRvZXMgbm90IG1hdGNoXG4gICAgICAgICAgLy8gc3Vic2NyaXB0aW9uLCB3ZSBkbyBub3QgbmVlZCB0byBjaGVjayBBQ0xcbiAgICAgICAgICBsZXQgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2U7XG4gICAgICAgICAgaWYgKCFpc09yaWdpbmFsU3Vic2NyaXB0aW9uTWF0Y2hlZCkge1xuICAgICAgICAgICAgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgb3JpZ2luYWxBQ0w7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICAgICAgICAgIG9yaWdpbmFsQUNMID0gbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UgPSB0aGlzLl9tYXRjaGVzQUNMKFxuICAgICAgICAgICAgICBvcmlnaW5hbEFDTCxcbiAgICAgICAgICAgICAgY2xpZW50LFxuICAgICAgICAgICAgICByZXF1ZXN0SWRcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFNldCBjdXJyZW50IFBhcnNlT2JqZWN0IEFDTCBjaGVja2luZyBwcm9taXNlLCBpZiB0aGUgb2JqZWN0IGRvZXMgbm90IG1hdGNoXG4gICAgICAgICAgLy8gc3Vic2NyaXB0aW9uLCB3ZSBkbyBub3QgbmVlZCB0byBjaGVjayBBQ0xcbiAgICAgICAgICBsZXQgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZTtcbiAgICAgICAgICBpZiAoIWlzQ3VycmVudFN1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgICAgIGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50QUNMID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QuZ2V0QUNMKCk7XG4gICAgICAgICAgICBjdXJyZW50QUNMQ2hlY2tpbmdQcm9taXNlID0gdGhpcy5fbWF0Y2hlc0FDTChcbiAgICAgICAgICAgICAgY3VycmVudEFDTCxcbiAgICAgICAgICAgICAgY2xpZW50LFxuICAgICAgICAgICAgICByZXF1ZXN0SWRcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IG9wID0gdGhpcy5fZ2V0Q0xQT3BlcmF0aW9uKHN1YnNjcmlwdGlvbi5xdWVyeSk7XG4gICAgICAgICAgdGhpcy5fbWF0Y2hlc0NMUChcbiAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgY2xpZW50LFxuICAgICAgICAgICAgcmVxdWVzdElkLFxuICAgICAgICAgICAgb3BcbiAgICAgICAgICApXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLmFsbChbXG4gICAgICAgICAgICAgICAgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UsXG4gICAgICAgICAgICAgICAgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSxcbiAgICAgICAgICAgICAgXSk7XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLnRoZW4oXG4gICAgICAgICAgICAgIChbaXNPcmlnaW5hbE1hdGNoZWQsIGlzQ3VycmVudE1hdGNoZWRdKSA9PiB7XG4gICAgICAgICAgICAgICAgbG9nZ2VyLnZlcmJvc2UoXG4gICAgICAgICAgICAgICAgICAnT3JpZ2luYWwgJWogfCBDdXJyZW50ICVqIHwgTWF0Y2g6ICVzLCAlcywgJXMsICVzIHwgUXVlcnk6ICVzJyxcbiAgICAgICAgICAgICAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgICAgICBjdXJyZW50UGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgICAgICBpc09yaWdpbmFsU3Vic2NyaXB0aW9uTWF0Y2hlZCxcbiAgICAgICAgICAgICAgICAgIGlzQ3VycmVudFN1YnNjcmlwdGlvbk1hdGNoZWQsXG4gICAgICAgICAgICAgICAgICBpc09yaWdpbmFsTWF0Y2hlZCxcbiAgICAgICAgICAgICAgICAgIGlzQ3VycmVudE1hdGNoZWQsXG4gICAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb24uaGFzaFxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAvLyBEZWNpZGUgZXZlbnQgdHlwZVxuICAgICAgICAgICAgICAgIGxldCB0eXBlO1xuICAgICAgICAgICAgICAgIGlmIChpc09yaWdpbmFsTWF0Y2hlZCAmJiBpc0N1cnJlbnRNYXRjaGVkKSB7XG4gICAgICAgICAgICAgICAgICB0eXBlID0gJ1VwZGF0ZSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpc09yaWdpbmFsTWF0Y2hlZCAmJiAhaXNDdXJyZW50TWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgICAgdHlwZSA9ICdMZWF2ZSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICghaXNPcmlnaW5hbE1hdGNoZWQgJiYgaXNDdXJyZW50TWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgICAgaWYgKG9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZSA9ICdFbnRlcic7XG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0eXBlID0gJ0NyZWF0ZSc7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IGZ1bmN0aW9uTmFtZSA9ICdwdXNoJyArIHR5cGU7XG5cbiAgICAgICAgICAgIGNvbnN0IHNzVG9rZW4gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpLnNlc3Npb25Ub2tlbjtcbiAgICAgICAgICAgIHRoaXMuc2Vzc2lvblRva2VuQ2FjaGUuZ2V0VXNlcklkKHNzVG9rZW4pLnRoZW4odXNlcklkID0+IHtcbiAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuY2FjaGVDb250cm9sbGVyLnJvbGUuZ2V0KHNzVG9rZW4pLnRoZW4oY1VzZXIgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChjVXNlcikgcmV0dXJuIGNVc2VyO1xuICAgICAgICAgICAgICAgIHJldHVybiAobmV3IFBhcnNlLlF1ZXJ5KFBhcnNlLlVzZXIpKS5lcXVhbFRvKFwib2JqZWN0SWRcIiwgdXNlcklkKS5saW1pdCgxMDAwMCkuZmluZCh7dXNlTWFzdGVyS2V5OnRydWV9KS50aGVuKHVzZXIgPT4ge1xuICAgICAgICAgICAgICAgICAgaWYgKCF1c2VyIHx8ICF1c2VyLmxlbmd0aCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgICAgICAgIHRoaXMuY2FjaGVDb250cm9sbGVyLnJvbGUucHV0KHNzVG9rZW4sIHVzZXJbMF0pO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkodXNlclswXSkpO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9KS50aGVuKHVzZXIgPT4ge1xuICAgICAgICAgICAgICBsZXQgcmVzdWx0ID0gY3VycmVudFBhcnNlT2JqZWN0O1xuICAgICAgICAgICAgICAodGhpcy5xdWVyeU1pZGRsZXdhcmUgfHwgW10pLmZvckVhY2god2FyZSA9PiByZXN1bHQgPSB3YXJlKHJlc3VsdC5jbGFzc05hbWUsIFtyZXN1bHRdLCB7dXNlcjoge2dldFRlYW1zOiAoKSA9PiB1c2VyLnRlYW1zfX0pWzBdKVxuICAgICAgICAgICAgICBjbGllbnRbZnVuY3Rpb25OYW1lXShyZXF1ZXN0SWQsIHJlc3VsdCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgIH0sIChlcnJvcikgPT4ge1xuICAgICAgICAgICAgbG9nZ2VyLmVycm9yKCdNYXRjaGluZyBBQ0wgZXJyb3IgOiAnLCBlcnJvcik7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBfb25Db25uZWN0KHBhcnNlV2Vic29ja2V0OiBhbnkpOiB2b2lkIHtcbiAgICBwYXJzZVdlYnNvY2tldC5vbignbWVzc2FnZScsIHJlcXVlc3QgPT4ge1xuICAgICAgaWYgKHR5cGVvZiByZXF1ZXN0ID09PSAnc3RyaW5nJykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcXVlc3QgPSBKU09OLnBhcnNlKHJlcXVlc3QpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKCd1bmFibGUgdG8gcGFyc2UgcmVxdWVzdCcsIHJlcXVlc3QsIGUpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ1JlcXVlc3Q6ICVqJywgcmVxdWVzdCk7XG5cbiAgICAgIC8vIENoZWNrIHdoZXRoZXIgdGhpcyByZXF1ZXN0IGlzIGEgdmFsaWQgcmVxdWVzdCwgcmV0dXJuIGVycm9yIGRpcmVjdGx5IGlmIG5vdFxuICAgICAgaWYgKFxuICAgICAgICAhdHY0LnZhbGlkYXRlKHJlcXVlc3QsIFJlcXVlc3RTY2hlbWFbJ2dlbmVyYWwnXSkgfHxcbiAgICAgICAgIXR2NC52YWxpZGF0ZShyZXF1ZXN0LCBSZXF1ZXN0U2NoZW1hW3JlcXVlc3Qub3BdKVxuICAgICAgKSB7XG4gICAgICAgIENsaWVudC5wdXNoRXJyb3IocGFyc2VXZWJzb2NrZXQsIDEsIHR2NC5lcnJvci5tZXNzYWdlKTtcbiAgICAgICAgbG9nZ2VyLmVycm9yKCdDb25uZWN0IG1lc3NhZ2UgZXJyb3IgJXMnLCB0djQuZXJyb3IubWVzc2FnZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgc3dpdGNoIChyZXF1ZXN0Lm9wKSB7XG4gICAgICAgIGNhc2UgJ2Nvbm5lY3QnOlxuICAgICAgICAgIHRoaXMuX2hhbmRsZUNvbm5lY3QocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdzdWJzY3JpYmUnOlxuICAgICAgICAgIHRoaXMuX2hhbmRsZVN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ3VwZGF0ZSc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlVXBkYXRlU3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAndW5zdWJzY3JpYmUnOlxuICAgICAgICAgIHRoaXMuX2hhbmRsZVVuc3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICBDbGllbnQucHVzaEVycm9yKHBhcnNlV2Vic29ja2V0LCAzLCAnR2V0IHVua25vd24gb3BlcmF0aW9uJyk7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKCdHZXQgdW5rbm93biBvcGVyYXRpb24nLCByZXF1ZXN0Lm9wKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHBhcnNlV2Vic29ja2V0Lm9uKCdkaXNjb25uZWN0JywgKCkgPT4ge1xuICAgICAgbG9nZ2VyLmluZm8oYENsaWVudCBkaXNjb25uZWN0OiAke3BhcnNlV2Vic29ja2V0LmNsaWVudElkfWApO1xuICAgICAgY29uc3QgY2xpZW50SWQgPSBwYXJzZVdlYnNvY2tldC5jbGllbnRJZDtcbiAgICAgIGlmICghdGhpcy5jbGllbnRzLmhhcyhjbGllbnRJZCkpIHtcbiAgICAgICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICAgICAgZXZlbnQ6ICd3c19kaXNjb25uZWN0X2Vycm9yJyxcbiAgICAgICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICAgICAgICBlcnJvcjogYFVuYWJsZSB0byBmaW5kIGNsaWVudCAke2NsaWVudElkfWAsXG4gICAgICAgIH0pO1xuICAgICAgICBsb2dnZXIuZXJyb3IoYENhbiBub3QgZmluZCBjbGllbnQgJHtjbGllbnRJZH0gb24gZGlzY29ubmVjdGApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIERlbGV0ZSBjbGllbnRcbiAgICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuY2xpZW50cy5nZXQoY2xpZW50SWQpO1xuICAgICAgdGhpcy5jbGllbnRzLmRlbGV0ZShjbGllbnRJZCk7XG5cbiAgICAgIC8vIERlbGV0ZSBjbGllbnQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICBmb3IgKGNvbnN0IFtyZXF1ZXN0SWQsIHN1YnNjcmlwdGlvbkluZm9dIG9mIF8uZW50cmllcyhcbiAgICAgICAgY2xpZW50LnN1YnNjcmlwdGlvbkluZm9zXG4gICAgICApKSB7XG4gICAgICAgIGNvbnN0IHN1YnNjcmlwdGlvbiA9IHN1YnNjcmlwdGlvbkluZm8uc3Vic2NyaXB0aW9uO1xuICAgICAgICBzdWJzY3JpcHRpb24uZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uKGNsaWVudElkLCByZXF1ZXN0SWQpO1xuXG4gICAgICAgIC8vIElmIHRoZXJlIGlzIG5vIGNsaWVudCB3aGljaCBpcyBzdWJzY3JpYmluZyB0aGlzIHN1YnNjcmlwdGlvbiwgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgICAgICBjb25zdCBjbGFzc1N1YnNjcmlwdGlvbnMgPSB0aGlzLnN1YnNjcmlwdGlvbnMuZ2V0KFxuICAgICAgICAgIHN1YnNjcmlwdGlvbi5jbGFzc05hbWVcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKCFzdWJzY3JpcHRpb24uaGFzU3Vic2NyaWJpbmdDbGllbnQoKSkge1xuICAgICAgICAgIGNsYXNzU3Vic2NyaXB0aW9ucy5kZWxldGUoc3Vic2NyaXB0aW9uLmhhc2gpO1xuICAgICAgICB9XG4gICAgICAgIC8vIElmIHRoZXJlIGlzIG5vIHN1YnNjcmlwdGlvbnMgdW5kZXIgdGhpcyBjbGFzcywgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgICAgICBpZiAoY2xhc3NTdWJzY3JpcHRpb25zLnNpemUgPT09IDApIHtcbiAgICAgICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuZGVsZXRlKHN1YnNjcmlwdGlvbi5jbGFzc05hbWUpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGxvZ2dlci52ZXJib3NlKCdDdXJyZW50IGNsaWVudHMgJWQnLCB0aGlzLmNsaWVudHMuc2l6ZSk7XG4gICAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBzdWJzY3JpcHRpb25zICVkJywgdGhpcy5zdWJzY3JpcHRpb25zLnNpemUpO1xuICAgICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICAgIGV2ZW50OiAnd3NfZGlzY29ubmVjdCcsXG4gICAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICBldmVudDogJ3dzX2Nvbm5lY3QnLFxuICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICB9KTtcbiAgfVxuXG4gIF9tYXRjaGVzU3Vic2NyaXB0aW9uKHBhcnNlT2JqZWN0OiBhbnksIHN1YnNjcmlwdGlvbjogYW55KTogYm9vbGVhbiB7XG4gICAgLy8gT2JqZWN0IGlzIHVuZGVmaW5lZCBvciBudWxsLCBub3QgbWF0Y2hcbiAgICBpZiAoIXBhcnNlT2JqZWN0KSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBtYXRjaGVzUXVlcnkocGFyc2VPYmplY3QsIHN1YnNjcmlwdGlvbi5xdWVyeSk7XG4gIH1cblxuICBnZXRBdXRoRm9yU2Vzc2lvblRva2VuKFxuICAgIHNlc3Npb25Ub2tlbjogP3N0cmluZ1xuICApOiBQcm9taXNlPHsgYXV0aDogP0F1dGgsIHVzZXJJZDogP3N0cmluZyB9PiB7XG4gICAgaWYgKCFzZXNzaW9uVG9rZW4pIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe30pO1xuICAgIH1cbiAgICBjb25zdCBmcm9tQ2FjaGUgPSB0aGlzLmF1dGhDYWNoZS5nZXQoc2Vzc2lvblRva2VuKTtcbiAgICBpZiAoZnJvbUNhY2hlKSB7XG4gICAgICByZXR1cm4gZnJvbUNhY2hlO1xuICAgIH1cbiAgICBjb25zdCBhdXRoUHJvbWlzZSA9IGdldEF1dGhGb3JTZXNzaW9uVG9rZW4oe1xuICAgICAgY2FjaGVDb250cm9sbGVyOiB0aGlzLmNhY2hlQ29udHJvbGxlcixcbiAgICAgIHNlc3Npb25Ub2tlbjogc2Vzc2lvblRva2VuLFxuICAgIH0pXG4gICAgICAudGhlbihhdXRoID0+IHtcbiAgICAgICAgcmV0dXJuIHsgYXV0aCwgdXNlcklkOiBhdXRoICYmIGF1dGgudXNlciAmJiBhdXRoLnVzZXIuaWQgfTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAvLyBUaGVyZSB3YXMgYW4gZXJyb3Igd2l0aCB0aGUgc2Vzc2lvbiB0b2tlblxuICAgICAgICBjb25zdCByZXN1bHQgPSB7fTtcbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTikge1xuICAgICAgICAgIC8vIFN0b3JlIGEgcmVzb2x2ZWQgcHJvbWlzZSB3aXRoIHRoZSBlcnJvciBmb3IgMTAgbWludXRlc1xuICAgICAgICAgIHJlc3VsdC5lcnJvciA9IGVycm9yO1xuICAgICAgICAgIHRoaXMuYXV0aENhY2hlLnNldChcbiAgICAgICAgICAgIHNlc3Npb25Ub2tlbixcbiAgICAgICAgICAgIFByb21pc2UucmVzb2x2ZShyZXN1bHQpLFxuICAgICAgICAgICAgNjAgKiAxMCAqIDEwMDBcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMuYXV0aENhY2hlLmRlbChzZXNzaW9uVG9rZW4pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICB9KTtcbiAgICB0aGlzLmF1dGhDYWNoZS5zZXQoc2Vzc2lvblRva2VuLCBhdXRoUHJvbWlzZSk7XG4gICAgcmV0dXJuIGF1dGhQcm9taXNlO1xuICB9XG5cbiAgYXN5bmMgX21hdGNoZXNDTFAoXG4gICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zOiA/YW55LFxuICAgIG9iamVjdDogYW55LFxuICAgIGNsaWVudDogYW55LFxuICAgIHJlcXVlc3RJZDogbnVtYmVyLFxuICAgIG9wOiBzdHJpbmdcbiAgKTogYW55IHtcbiAgICAvLyB0cnkgdG8gbWF0Y2ggb24gdXNlciBmaXJzdCwgbGVzcyBleHBlbnNpdmUgdGhhbiB3aXRoIHJvbGVzXG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IGNsaWVudC5nZXRTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgY29uc3QgYWNsR3JvdXAgPSBbJyonXTtcbiAgICBsZXQgdXNlcklkO1xuICAgIGlmICh0eXBlb2Ygc3Vic2NyaXB0aW9uSW5mbyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIGNvbnN0IHsgdXNlcklkIH0gPSBhd2FpdCB0aGlzLmdldEF1dGhGb3JTZXNzaW9uVG9rZW4oXG4gICAgICAgIHN1YnNjcmlwdGlvbkluZm8uc2Vzc2lvblRva2VuXG4gICAgICApO1xuICAgICAgaWYgKHVzZXJJZCkge1xuICAgICAgICBhY2xHcm91cC5wdXNoKHVzZXJJZCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBTY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihcbiAgICAgICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICAgICAgICBvYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgb3BcbiAgICAgICk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dnZXIudmVyYm9zZShgRmFpbGVkIG1hdGNoaW5nIENMUCBmb3IgJHtvYmplY3QuaWR9ICR7dXNlcklkfSAke2V9YCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIC8vIFRPRE86IGhhbmRsZSByb2xlcyBwZXJtaXNzaW9uc1xuICAgIC8vIE9iamVjdC5rZXlzKGNsYXNzTGV2ZWxQZXJtaXNzaW9ucykuZm9yRWFjaCgoa2V5KSA9PiB7XG4gICAgLy8gICBjb25zdCBwZXJtID0gY2xhc3NMZXZlbFBlcm1pc3Npb25zW2tleV07XG4gICAgLy8gICBPYmplY3Qua2V5cyhwZXJtKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAvLyAgICAgaWYgKGtleS5pbmRleE9mKCdyb2xlJykpXG4gICAgLy8gICB9KTtcbiAgICAvLyB9KVxuICAgIC8vIC8vIGl0J3MgcmVqZWN0ZWQgaGVyZSwgY2hlY2sgdGhlIHJvbGVzXG4gICAgLy8gdmFyIHJvbGVzUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoUGFyc2UuUm9sZSk7XG4gICAgLy8gcm9sZXNRdWVyeS5lcXVhbFRvKFwidXNlcnNcIiwgdXNlcik7XG4gICAgLy8gcmV0dXJuIHJvbGVzUXVlcnkuZmluZCh7dXNlTWFzdGVyS2V5OnRydWV9KTtcbiAgfVxuXG4gIF9nZXRDTFBPcGVyYXRpb24ocXVlcnk6IGFueSkge1xuICAgIHJldHVybiB0eXBlb2YgcXVlcnkgPT09ICdvYmplY3QnICYmXG4gICAgICBPYmplY3Qua2V5cyhxdWVyeSkubGVuZ3RoID09IDEgJiZcbiAgICAgIHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PT0gJ3N0cmluZydcbiAgICAgID8gJ2dldCdcbiAgICAgIDogJ2ZpbmQnO1xuICB9XG5cbiAgYXN5bmMgX3ZlcmlmeUFDTChhY2w6IGFueSwgdG9rZW46IHN0cmluZykge1xuICAgIGlmICghdG9rZW4pIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBjb25zdCB7IGF1dGgsIHVzZXJJZCB9ID0gYXdhaXQgdGhpcy5nZXRBdXRoRm9yU2Vzc2lvblRva2VuKHRva2VuKTtcblxuICAgIC8vIEdldHRpbmcgdGhlIHNlc3Npb24gdG9rZW4gZmFpbGVkXG4gICAgLy8gVGhpcyBtZWFucyB0aGF0IG5vIGFkZGl0aW9uYWwgYXV0aCBpcyBhdmFpbGFibGVcbiAgICAvLyBBdCB0aGlzIHBvaW50LCBqdXN0IGJhaWwgb3V0IGFzIG5vIGFkZGl0aW9uYWwgdmlzaWJpbGl0eSBjYW4gYmUgaW5mZXJyZWQuXG4gICAgaWYgKCFhdXRoIHx8ICF1c2VySWQpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgaXNTdWJzY3JpcHRpb25TZXNzaW9uVG9rZW5NYXRjaGVkID0gYWNsLmdldFJlYWRBY2Nlc3ModXNlcklkKTtcbiAgICBpZiAoaXNTdWJzY3JpcHRpb25TZXNzaW9uVG9rZW5NYXRjaGVkKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBpZiB0aGUgdXNlciBoYXMgYW55IHJvbGVzIHRoYXQgbWF0Y2ggdGhlIEFDTFxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICAvLyBSZXNvbHZlIGZhbHNlIHJpZ2h0IGF3YXkgaWYgdGhlIGFjbCBkb2Vzbid0IGhhdmUgYW55IHJvbGVzXG4gICAgICAgIGNvbnN0IGFjbF9oYXNfcm9sZXMgPSBPYmplY3Qua2V5cyhhY2wucGVybWlzc2lvbnNCeUlkKS5zb21lKGtleSA9PlxuICAgICAgICAgIGtleS5zdGFydHNXaXRoKCdyb2xlOicpXG4gICAgICAgICk7XG4gICAgICAgIGlmICghYWNsX2hhc19yb2xlcykge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnNlc3Npb25Ub2tlbkNhY2hlLmdldFVzZXJJZChzdWJzY3JpcHRpb25TZXNzaW9uVG9rZW4pXG4gICAgICAgIC50aGVuKCh1c2VySWQpID0+IHtcbiAgICAgICAgICAgIC8vIFBhc3MgYWxvbmcgYSBudWxsIGlmIHRoZXJlIGlzIG5vIHVzZXIgaWRcbiAgICAgICAgICBpZiAoIXVzZXJJZCkge1xuICAgICAgICAgICAgcmV0dXJuIFBhcnNlLlByb21pc2UuYXMobnVsbCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHZhciB1c2VyID0gbmV3IFBhcnNlLlVzZXIoKTtcbiAgICAgICAgICB1c2VyLmlkID0gdXNlcklkO1xuICAgICAgICAgIHJldHVybiB1c2VyO1xuXG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKHVzZXIgPT4ge1xuICAgICAgICAgIC8vIFBhc3MgYWxvbmcgYW4gZW1wdHkgYXJyYXkgKG9mIHJvbGVzKSBpZiBubyB1c2VyXG4gICAgICAgICAgaWYgKCF1c2VyKSB7XG4gICAgICAgICAgICByZXR1cm4gUGFyc2UuUHJvbWlzZS5hcyhbXSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHRoaXMuY2FjaGVDb250cm9sbGVyXG4gICAgICAgICAgICAmJiB0aGlzLmNhY2hlQ29udHJvbGxlci5hZGFwdGVyXG4gICAgICAgICAgICAmJiB0aGlzLmNhY2hlQ29udHJvbGxlci5hZGFwdGVyIGluc3RhbmNlb2YgUmVkaXNDYWNoZUFkYXB0ZXIpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNhY2hlQ29udHJvbGxlci5yb2xlLmdldCh1c2VyLmlkKS50aGVuKHJvbGVzID0+IHtcbiAgICAgICAgICAgICAgaWYgKHJvbGVzICE9IG51bGwpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnTGl2ZVF1ZXJ5OiB1c2luZyByb2xlcyBmcm9tIGNhY2hlIGZvciB1c2VyICcgKyB1c2VyLmlkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcm9sZXMubWFwKHJvbGUgPT4gcm9sZS5yZXBsYWNlKC9ecm9sZTovLCAnJykpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdMaXZlUXVlcnk6IGxvYWRpbmcgcm9sZXMgZnJvbSBkYXRhYmFzZSBhcyB0aGV5XFwncmUgbm90IGNhY2hlZCBmb3IgdXNlciAnICsgdXNlci5pZCk7XG4gICAgICAgICAgICAgIHJldHVybiB0aGlzLmxvYWRSb2xlc0RlbGVnYXRlKHVzZXIsIHRoaXMuY2FjaGVDb250cm9sbGVyKS50aGVuKHJvbGVzID0+IHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgTGl2ZVF1ZXJ5OiB1c2VyOiAke3VzZXIuaWR9bG9hZGVkIHJvbGVzOmAgKyByb2xlcyk7XG4gICAgICAgICAgICAgICAgdGhpcy5jYWNoZUNvbnRyb2xsZXIucm9sZS5wdXQodXNlci5pZCwgcm9sZXMubWFwKHJvbGUgPT4gJ3JvbGU6JyArIHJvbGUpKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcm9sZXM7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9IGVsc2UgeyAvLyBmYWxsYmFjayB0byBkaXJlY3QgcXVlcnlcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCdMaXZlUXVlcnk6IGZhbGxiYWNrOiBsb2FkaW5nIHJvbGVzIGZyb20gZGF0YWJhc2UgZm9yIHVzZXIgJyArIHVzZXIuaWQpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMubG9hZFJvbGVzRGVsZWdhdGUodXNlciwgdGhpcy5jYWNoZUNvbnRyb2xsZXIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSkuXG4gICAgICAgIHRoZW4ocm9sZXMgPT4ge1xuICAgICAgICAgIC8vIEZpbmFsbHksIHNlZSBpZiBhbnkgb2YgdGhlIHVzZXIncyByb2xlcyBhbGxvdyB0aGVtIHJlYWQgYWNjZXNzXG4gICAgICAgICAgcmV0dXJuICEhfnJvbGVzLmZpbmRJbmRleChyb2xlID0+IGFjbC5nZXRSb2xlUmVhZEFjY2Vzcyhyb2xlKSk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICBjb25zb2xlLmxvZygnTGl2ZVF1ZXJ5OiBlcnJvcjonLCBlcnJvcik7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9KTtcblxuICAgICAgfSk7XG5cbiAgfVxuXG4gIGFzeW5jIF9tYXRjaGVzQUNMKFxuICAgIGFjbDogYW55LFxuICAgIGNsaWVudDogYW55LFxuICAgIHJlcXVlc3RJZDogbnVtYmVyXG4gICk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIC8vIFJldHVybiB0cnVlIGRpcmVjdGx5IGlmIEFDTCBpc24ndCBwcmVzZW50LCBBQ0wgaXMgcHVibGljIHJlYWQsIG9yIGNsaWVudCBoYXMgbWFzdGVyIGtleVxuICAgIGlmICghYWNsIHx8IGFjbC5nZXRQdWJsaWNSZWFkQWNjZXNzKCkgfHwgY2xpZW50Lmhhc01hc3RlcktleSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIC8vIENoZWNrIHN1YnNjcmlwdGlvbiBzZXNzaW9uVG9rZW4gbWF0Y2hlcyBBQ0wgZmlyc3RcbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICBpZiAodHlwZW9mIHN1YnNjcmlwdGlvbkluZm8gPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uVG9rZW4gPSBzdWJzY3JpcHRpb25JbmZvLnNlc3Npb25Ub2tlbjtcbiAgICBjb25zdCBjbGllbnRTZXNzaW9uVG9rZW4gPSBjbGllbnQuc2Vzc2lvblRva2VuO1xuXG4gICAgaWYgKGF3YWl0IHRoaXMuX3ZlcmlmeUFDTChhY2wsIHN1YnNjcmlwdGlvblRva2VuKSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgaWYgKGF3YWl0IHRoaXMuX3ZlcmlmeUFDTChhY2wsIGNsaWVudFNlc3Npb25Ub2tlbikpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBfaGFuZGxlQ29ubmVjdChwYXJzZVdlYnNvY2tldDogYW55LCByZXF1ZXN0OiBhbnkpOiBhbnkge1xuICAgIGlmICghdGhpcy5fdmFsaWRhdGVLZXlzKHJlcXVlc3QsIHRoaXMua2V5UGFpcnMpKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKHBhcnNlV2Vic29ja2V0LCA0LCAnS2V5IGluIHJlcXVlc3QgaXMgbm90IHZhbGlkJyk7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0tleSBpbiByZXF1ZXN0IGlzIG5vdCB2YWxpZCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBoYXNNYXN0ZXJLZXkgPSB0aGlzLl9oYXNNYXN0ZXJLZXkocmVxdWVzdCwgdGhpcy5rZXlQYWlycyk7XG4gICAgY29uc3QgY2xpZW50SWQgPSB1dWlkKCk7XG4gICAgY29uc3QgY2xpZW50ID0gbmV3IENsaWVudChjbGllbnRJZCwgcGFyc2VXZWJzb2NrZXQsIGhhc01hc3RlcktleSk7XG4gICAgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgPSBjbGllbnRJZDtcbiAgICB0aGlzLmNsaWVudHMuc2V0KHBhcnNlV2Vic29ja2V0LmNsaWVudElkLCBjbGllbnQpO1xuICAgIGxvZ2dlci5pbmZvKGBDcmVhdGUgbmV3IGNsaWVudDogJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH1gKTtcbiAgICBjbGllbnQucHVzaENvbm5lY3QoKTtcbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGV2ZW50OiAnY29ubmVjdCcsXG4gICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgIH0pO1xuICB9XG5cbiAgX2hhc01hc3RlcktleShyZXF1ZXN0OiBhbnksIHZhbGlkS2V5UGFpcnM6IGFueSk6IGJvb2xlYW4ge1xuICAgIGlmIChcbiAgICAgICF2YWxpZEtleVBhaXJzIHx8XG4gICAgICB2YWxpZEtleVBhaXJzLnNpemUgPT0gMCB8fFxuICAgICAgIXZhbGlkS2V5UGFpcnMuaGFzKCdtYXN0ZXJLZXknKVxuICAgICkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAoIXJlcXVlc3QgfHwgIXJlcXVlc3QuaGFzT3duUHJvcGVydHkoJ21hc3RlcktleScpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiByZXF1ZXN0Lm1hc3RlcktleSA9PT0gdmFsaWRLZXlQYWlycy5nZXQoJ21hc3RlcktleScpO1xuICB9XG5cbiAgX3ZhbGlkYXRlS2V5cyhyZXF1ZXN0OiBhbnksIHZhbGlkS2V5UGFpcnM6IGFueSk6IGJvb2xlYW4ge1xuICAgIGlmICghdmFsaWRLZXlQYWlycyB8fCB2YWxpZEtleVBhaXJzLnNpemUgPT0gMCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGxldCBpc1ZhbGlkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBba2V5LCBzZWNyZXRdIG9mIHZhbGlkS2V5UGFpcnMpIHtcbiAgICAgIGlmICghcmVxdWVzdFtrZXldIHx8IHJlcXVlc3Rba2V5XSAhPT0gc2VjcmV0KSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaXNWYWxpZCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIGlzVmFsaWQ7XG4gIH1cblxuICBfaGFuZGxlU3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0OiBhbnksIHJlcXVlc3Q6IGFueSk6IGFueSB7XG4gICAgLy8gSWYgd2UgY2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCByZXR1cm4gZXJyb3IgdG8gY2xpZW50XG4gICAgaWYgKCFwYXJzZVdlYnNvY2tldC5oYXNPd25Qcm9wZXJ0eSgnY2xpZW50SWQnKSkge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihcbiAgICAgICAgcGFyc2VXZWJzb2NrZXQsXG4gICAgICAgIDIsXG4gICAgICAgICdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHN1YnNjcmliaW5nJ1xuICAgICAgKTtcbiAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgc3Vic2NyaWJpbmcnXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KHBhcnNlV2Vic29ja2V0LmNsaWVudElkKTtcblxuICAgIC8vIEdldCBzdWJzY3JpcHRpb24gZnJvbSBzdWJzY3JpcHRpb25zLCBjcmVhdGUgb25lIGlmIG5lY2Vzc2FyeVxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkhhc2ggPSBxdWVyeUhhc2gocmVxdWVzdC5xdWVyeSk7XG4gICAgLy8gQWRkIGNsYXNzTmFtZSB0byBzdWJzY3JpcHRpb25zIGlmIG5lY2Vzc2FyeVxuICAgIGNvbnN0IGNsYXNzTmFtZSA9IHJlcXVlc3QucXVlcnkuY2xhc3NOYW1lO1xuICAgIGlmICghdGhpcy5zdWJzY3JpcHRpb25zLmhhcyhjbGFzc05hbWUpKSB7XG4gICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuc2V0KGNsYXNzTmFtZSwgbmV3IE1hcCgpKTtcbiAgICB9XG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGxldCBzdWJzY3JpcHRpb247XG4gICAgaWYgKGNsYXNzU3Vic2NyaXB0aW9ucy5oYXMoc3Vic2NyaXB0aW9uSGFzaCkpIHtcbiAgICAgIHN1YnNjcmlwdGlvbiA9IGNsYXNzU3Vic2NyaXB0aW9ucy5nZXQoc3Vic2NyaXB0aW9uSGFzaCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN1YnNjcmlwdGlvbiA9IG5ldyBTdWJzY3JpcHRpb24oXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgcmVxdWVzdC5xdWVyeS53aGVyZSxcbiAgICAgICAgc3Vic2NyaXB0aW9uSGFzaFxuICAgICAgKTtcbiAgICAgIGNsYXNzU3Vic2NyaXB0aW9ucy5zZXQoc3Vic2NyaXB0aW9uSGFzaCwgc3Vic2NyaXB0aW9uKTtcbiAgICB9XG5cbiAgICAvLyBBZGQgc3Vic2NyaXB0aW9uSW5mbyB0byBjbGllbnRcbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0ge1xuICAgICAgc3Vic2NyaXB0aW9uOiBzdWJzY3JpcHRpb24sXG4gICAgfTtcbiAgICAvLyBBZGQgc2VsZWN0ZWQgZmllbGRzIGFuZCBzZXNzaW9uVG9rZW4gZm9yIHRoaXMgc3Vic2NyaXB0aW9uIGlmIG5lY2Vzc2FyeVxuICAgIGlmIChyZXF1ZXN0LnF1ZXJ5LmZpZWxkcykge1xuICAgICAgc3Vic2NyaXB0aW9uSW5mby5maWVsZHMgPSByZXF1ZXN0LnF1ZXJ5LmZpZWxkcztcbiAgICB9XG4gICAgaWYgKHJlcXVlc3Quc2Vzc2lvblRva2VuKSB7XG4gICAgICBzdWJzY3JpcHRpb25JbmZvLnNlc3Npb25Ub2tlbiA9IHJlcXVlc3Quc2Vzc2lvblRva2VuO1xuICAgIH1cbiAgICBjbGllbnQuYWRkU3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0LnJlcXVlc3RJZCwgc3Vic2NyaXB0aW9uSW5mbyk7XG5cbiAgICAvLyBBZGQgY2xpZW50SWQgdG8gc3Vic2NyaXB0aW9uXG4gICAgc3Vic2NyaXB0aW9uLmFkZENsaWVudFN1YnNjcmlwdGlvbihcbiAgICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkLFxuICAgICAgcmVxdWVzdC5yZXF1ZXN0SWRcbiAgICApO1xuXG4gICAgY2xpZW50LnB1c2hTdWJzY3JpYmUocmVxdWVzdC5yZXF1ZXN0SWQpO1xuXG4gICAgbG9nZ2VyLnZlcmJvc2UoXG4gICAgICBgQ3JlYXRlIGNsaWVudCAke3BhcnNlV2Vic29ja2V0LmNsaWVudElkfSBuZXcgc3Vic2NyaXB0aW9uOiAke1xuICAgICAgICByZXF1ZXN0LnJlcXVlc3RJZFxuICAgICAgfWBcbiAgICApO1xuICAgIGxvZ2dlci52ZXJib3NlKCdDdXJyZW50IGNsaWVudCBudW1iZXI6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgZXZlbnQ6ICdzdWJzY3JpYmUnLFxuICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICB9KTtcbiAgfVxuXG4gIF9oYW5kbGVVcGRhdGVTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQ6IGFueSwgcmVxdWVzdDogYW55KTogYW55IHtcbiAgICB0aGlzLl9oYW5kbGVVbnN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCwgZmFsc2UpO1xuICAgIHRoaXMuX2hhbmRsZVN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gIH1cblxuICBfaGFuZGxlVW5zdWJzY3JpYmUoXG4gICAgcGFyc2VXZWJzb2NrZXQ6IGFueSxcbiAgICByZXF1ZXN0OiBhbnksXG4gICAgbm90aWZ5Q2xpZW50OiBib29sZWFuID0gdHJ1ZVxuICApOiBhbnkge1xuICAgIC8vIElmIHdlIGNhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgcmV0dXJuIGVycm9yIHRvIGNsaWVudFxuICAgIGlmICghcGFyc2VXZWJzb2NrZXQuaGFzT3duUHJvcGVydHkoJ2NsaWVudElkJykpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCBtYWtlIHN1cmUgeW91IGNvbm5lY3QgdG8gc2VydmVyIGJlZm9yZSB1bnN1YnNjcmliaW5nJ1xuICAgICAgKTtcbiAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZydcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3RJZCA9IHJlcXVlc3QucmVxdWVzdElkO1xuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuY2xpZW50cy5nZXQocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQpO1xuICAgIGlmICh0eXBlb2YgY2xpZW50ID09PSAndW5kZWZpbmVkJykge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihcbiAgICAgICAgcGFyc2VXZWJzb2NrZXQsXG4gICAgICAgIDIsXG4gICAgICAgICdDYW5ub3QgZmluZCBjbGllbnQgd2l0aCBjbGllbnRJZCAnICtcbiAgICAgICAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCArXG4gICAgICAgICAgJy4gTWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIGxpdmUgcXVlcnkgc2VydmVyIGJlZm9yZSB1bnN1YnNjcmliaW5nLidcbiAgICAgICk7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCAnICsgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm8gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIGlmICh0eXBlb2Ygc3Vic2NyaXB0aW9uSW5mbyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2Fubm90IGZpbmQgc3Vic2NyaXB0aW9uIHdpdGggY2xpZW50SWQgJyArXG4gICAgICAgICAgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgK1xuICAgICAgICAgICcgc3Vic2NyaXB0aW9uSWQgJyArXG4gICAgICAgICAgcmVxdWVzdElkICtcbiAgICAgICAgICAnLiBNYWtlIHN1cmUgeW91IHN1YnNjcmliZSB0byBsaXZlIHF1ZXJ5IHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZy4nXG4gICAgICApO1xuICAgICAgbG9nZ2VyLmVycm9yKFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHN1YnNjcmlwdGlvbiB3aXRoIGNsaWVudElkICcgK1xuICAgICAgICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkICtcbiAgICAgICAgICAnIHN1YnNjcmlwdGlvbklkICcgK1xuICAgICAgICAgIHJlcXVlc3RJZFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBSZW1vdmUgc3Vic2NyaXB0aW9uIGZyb20gY2xpZW50XG4gICAgY2xpZW50LmRlbGV0ZVN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICAvLyBSZW1vdmUgY2xpZW50IGZyb20gc3Vic2NyaXB0aW9uXG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uID0gc3Vic2NyaXB0aW9uSW5mby5zdWJzY3JpcHRpb247XG4gICAgY29uc3QgY2xhc3NOYW1lID0gc3Vic2NyaXB0aW9uLmNsYXNzTmFtZTtcbiAgICBzdWJzY3JpcHRpb24uZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0LmNsaWVudElkLCByZXF1ZXN0SWQpO1xuICAgIC8vIElmIHRoZXJlIGlzIG5vIGNsaWVudCB3aGljaCBpcyBzdWJzY3JpYmluZyB0aGlzIHN1YnNjcmlwdGlvbiwgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoY2xhc3NOYW1lKTtcbiAgICBpZiAoIXN1YnNjcmlwdGlvbi5oYXNTdWJzY3JpYmluZ0NsaWVudCgpKSB7XG4gICAgICBjbGFzc1N1YnNjcmlwdGlvbnMuZGVsZXRlKHN1YnNjcmlwdGlvbi5oYXNoKTtcbiAgICB9XG4gICAgLy8gSWYgdGhlcmUgaXMgbm8gc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgaWYgKGNsYXNzU3Vic2NyaXB0aW9ucy5zaXplID09PSAwKSB7XG4gICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuZGVsZXRlKGNsYXNzTmFtZSk7XG4gICAgfVxuICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgZXZlbnQ6ICd1bnN1YnNjcmliZScsXG4gICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgIH0pO1xuXG4gICAgaWYgKCFub3RpZnlDbGllbnQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjbGllbnQucHVzaFVuc3Vic2NyaWJlKHJlcXVlc3QucmVxdWVzdElkKTtcblxuICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgYERlbGV0ZSBjbGllbnQ6ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9IHwgc3Vic2NyaXB0aW9uOiAke1xuICAgICAgICByZXF1ZXN0LnJlcXVlc3RJZFxuICAgICAgfWBcbiAgICApO1xuICB9XG59XG5cbmV4cG9ydCB7IFBhcnNlTGl2ZVF1ZXJ5U2VydmVyIH07XG4iXX0=